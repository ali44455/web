import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import {
  createRunDir,
  runDirFor,
  loadStage2RunRecord,
  loadRunRecord,
} from "../services/runStore";
import { streamStage4Engine, type Stage4EngineResult } from "../services/stage4Engine";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── POST /stage4/runs ────────────────────────────────────────────────────────
// Creates a run record and returns the runId. The actual computation is
// streamed via GET /stage4/runs/:runId/stream.
router.post("/stage4/runs", async (req, res): Promise<void> => {
  const { stage2RunId, txPowerDbm, targetRssiThreshold, nIterations, stepAngle } = req.body as {
    stage2RunId?: string;
    txPowerDbm?: number;
    targetRssiThreshold?: number;
    nIterations?: number;
    stepAngle?: number;
  };

  if (!stage2RunId) {
    res.status(400).json({ error: "stage2RunId is required" });
    return;
  }

  const stage2Record = await loadStage2RunRecord(stage2RunId);
  if (!stage2Record) {
    res.status(400).json({ error: `Stage 2 run '${stage2RunId}' not found` });
    return;
  }

  const stage1Record = await loadRunRecord(stage2Record.stage1RunId);
  if (!stage1Record) {
    res.status(400).json({ error: `Stage 1 run '${stage2Record.stage1RunId}' not found` });
    return;
  }

  const { runId, runDir } = await createRunDir();

  // Derive physical dimensions from stage1 grid params
  const cellSize  = stage1Record.resolvedParams?.cellSizeMeters ?? 1.0;
  // Stage2 image dimensions are in ROI-cropped pixel space
  const realWidth  = stage2Record.imageWidth  * cellSize;
  const realHeight = stage2Record.imageHeight * cellSize;
  const freqHz     = (stage1Record.resolvedParams?.frequencyMHz ?? 50) * 1e6;

  // Transmitter is in ROI-cropped pixel coords from stage2
  const [txPx, tyPx] = stage2Record.transmitter;
  const antennaXMeters = txPx * cellSize;
  const antennaYMeters = tyPx * cellSize;

  // Save a pending record so GET :runId/stream can find the params
  const pendingParams = {
    stage2RunId,
    stage1RunId: stage2Record.stage1RunId,
    realWidth,
    realHeight,
    freqHz,
    txPowerDbm:           txPowerDbm          ?? 19,
    targetRssiThreshold:  targetRssiThreshold ?? -80,
    nIterations:          nIterations         ?? 10,
    stepAngle:            stepAngle           ?? 0.1,
    antennaXMeters,
    antennaYMeters,
    alphaEff: stage1Record.resolvedParams?.absorptionCoeff ?? 0.062,
    refractiveIndex: stage1Record.resolvedParams?.refractiveIndex ?? 2.0,
    pmlWidth: stage1Record.resolvedParams?.pmlWidth ?? 20,
    pmlMaxLoss: stage1Record.resolvedParams?.pmlMaxLoss ?? 0.5,
    alpha3dBump: stage1Record.resolvedParams?.alpha3dBump ?? 0.0,
    finalNodes: stage2Record.finalNodes,
  };
  await fs.writeFile(
    path.join(runDir, "stage4-pending.json"),
    JSON.stringify(pendingParams),
  );

  res.status(201).json({ runId });
});

// ─── GET /stage4/runs/:runId/stream ──────────────────────────────────────────
// SSE endpoint. Spawns the Python engine and streams JSON-line events as
// Server-Sent Events. If the run already completed (result.json exists) it
// responds with a single "already_done" event and closes.
router.get("/stage4/runs/:runId/stream", async (req, res): Promise<void> => {
  const runId  = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const runDir = runDirFor(runId);

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: string) => {
    res.write(`data: ${data}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  // If already complete, serve result from disk
  const resultPath = path.join(runDir, "result.json");
  try {
    await fs.access(resultPath);
    const raw = await fs.readFile(resultPath, "utf-8");
    send(JSON.stringify({ type: "already_done", result: JSON.parse(raw) }));
    res.end();
    return;
  } catch {
    // Not yet complete — continue to spawn
  }

  // Load pending params
  let pending: any;
  try {
    const raw = await fs.readFile(path.join(runDir, "stage4-pending.json"), "utf-8");
    pending = JSON.parse(raw);
  } catch {
    send(JSON.stringify({ type: "error", message: "Stage 4 run not found" }));
    res.end();
    return;
  }

  const stage1RunDir = runDirFor(pending.stage1RunId);
  const stage2RunDir = runDirFor(pending.stage2RunId);

  const abortCtrl = new AbortController();
  req.on("close", () => abortCtrl.abort());

  try {
    req.log.info({ runId, stage2RunId: pending.stage2RunId }, "Starting Stage 4 stream");

    await streamStage4Engine(
      stage1RunDir,
      stage2RunDir,
      runDir,
      {
        realWidth:           pending.realWidth,
        realHeight:          pending.realHeight,
        freqHz:              pending.freqHz,
        txPowerDbm:          pending.txPowerDbm,
        alphaAir:            pending.alphaAir,
        alphaEff:            pending.alphaEff,
        refractiveIndex:     pending.refractiveIndex,
        pmlWidth:            pending.pmlWidth,
        pmlMaxLoss:          pending.pmlMaxLoss,
        alpha3dBump:         pending.alpha3dBump,
        targetRssiThreshold: pending.targetRssiThreshold,
        nIterations:         pending.nIterations,
        stepAngle:           pending.stepAngle,
        antennaXMeters:      pending.antennaXMeters,
        antennaYMeters:      pending.antennaYMeters,
        finalNodes:          pending.finalNodes,
      },
      send,
      abortCtrl.signal,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stage 4 failed";
    req.log.error({ err, runId }, "Stage 4 stream error");
    send(JSON.stringify({ type: "error", message }));
  } finally {
    res.end();
  }
});

// ─── GET /stage4/runs/:runId ──────────────────────────────────────────────────
router.get("/stage4/runs/:runId", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const runDir = runDirFor(runId);

  try {
    const raw = await fs.readFile(path.join(runDir, "result.json"), "utf-8");
    const result = JSON.parse(raw) as Stage4EngineResult;

    // Load max_hold image
    let maxHoldBase64: string | null = null;
    try {
      const png = await fs.readFile(path.join(runDir, "max_hold.png"));
      maxHoldBase64 = `data:image/png;base64,${png.toString("base64")}`;
    } catch {
      // not yet saved
    }

    res.json({
      runId,
      ...result,
      videoUrl: result.videoAvailable
        ? `/api/stage4/runs/${runId}/video`
        : null,
      maxHoldImageBase64: maxHoldBase64,
    });
  } catch {
    res.status(404).json({ error: "Stage 4 run not found or not yet complete" });
  }
});

// Download/play the real MP4 generated from the streamed simulation frames.
router.get("/stage4/runs/:runId/video", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const videoPath = path.join(runDirFor(runId), "phased-array-simulation.mp4");
  try {
    await fs.access(videoPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="phased-array-simulation-${runId}.mp4"`);
    fsSync.createReadStream(videoPath).pipe(res);
  } catch {
    res.status(404).json({ error: "Stage 4 video not found or not yet complete" });
  }
});

// Self-contained engineering export: solver metadata plus the max-hold
// heatmap image. The UI splits it into a readable PNG and JSON placement file.
router.get("/stage4/runs/:runId/export", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const runDir = runDirFor(runId);
  try {
    const result = JSON.parse(await fs.readFile(path.join(runDir, "result.json"), "utf-8"));
    const png = await fs.readFile(path.join(runDir, "max_hold.png"));
    res.json({
      runId,
      ...result,
      maxHoldImageBase64: `data:image/png;base64,${png.toString("base64")}`,
    });
  } catch {
    res.status(404).json({ error: "Stage 4 export is not available yet" });
  }
});

export default router;
