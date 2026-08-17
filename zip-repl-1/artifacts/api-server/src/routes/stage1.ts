import { Router, type IRouter } from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import {
  CreateStage1RunResponse,
  ListStage1RunsResponse,
  GetStage1RunResponse,
} from "@workspace/api-zod";
import {
  runStage1EngineFromStage0,
  runStage1EngineFromRawImage,
  cropStage1Roi,
  type Stage1FormFields,
} from "../services/stage1Engine";
import {
  createRunDir,
  saveRunRecord,
  loadRunRecord,
  loadHeatmapBase64,
  listRunRecords,
  loadStage0RunRecord,
  stage0MaskPathFor,
  stage0ProcessedMapPathFor,
  runDirFor,
} from "../services/runStore";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const NUMERIC_FIELDS: (keyof Stage1FormFields)[] = [
  "cellSizeMeters",
  "realWidthMeters",
  "frequencyMHz",
  "refractiveIndex",
  "absorptionCoeff",
  "sourceValue",
  "minDb",
  "pmlWidth",
  "pmlMaxLoss",
  "alpha3dBump",
  "sourceXPercent",
  "sourceYPercent",
  "cellBudget",
];

function parseFormFields(body: Record<string, unknown>): Stage1FormFields {
  const fields: Stage1FormFields = {};
  for (const key of NUMERIC_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    (fields as Record<string, number>)[key] = num;
  }
  return fields;
}

router.post("/stage1/runs", upload.single("map"), async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const stage0RunId = typeof body.stage0RunId === "string" && body.stage0RunId.length > 0
    ? body.stage0RunId
    : undefined;

  if (stage0RunId && req.file) {
    res.status(400).json({ error: "Provide either 'stage0RunId' or 'map', not both" });
    return;
  }
  if (!stage0RunId && !req.file) {
    res.status(400).json({ error: "Provide either 'stage0RunId' (preferred) or a 'map' image file" });
    return;
  }

  const fields = parseFormFields(body);
  const { runId, runDir } = await createRunDir();
  const imagePath = req.file ? path.join(runDir, "map-source") : null;

  try {
    let engineResult;

    if (stage0RunId) {
      const stage0Record = await loadStage0RunRecord(stage0RunId);
      if (!stage0Record) {
        res.status(400).json({ error: `Stage 0 run '${stage0RunId}' not found` });
        return;
      }
      engineResult = await runStage1EngineFromStage0(
        stage0MaskPathFor(stage0RunId),
        stage0ProcessedMapPathFor(stage0RunId),
        fields,
        runDir,
      );
    } else {
      await fs.writeFile(imagePath as string, (req.file as Express.Multer.File).buffer);
      engineResult = await runStage1EngineFromRawImage(imagePath as string, fields, runDir);
    }

    const record = await saveRunRecord(runId, runDir, engineResult, stage0RunId);
    const heatmapImageBase64 = await loadHeatmapBase64(runId);

    if (!heatmapImageBase64) {
      req.log.error({ runId }, "Stage 1 heatmap missing after successful run");
      res.status(500).json({ error: "Simulation completed but the heatmap could not be read" });
      return;
    }

    res.status(201).json(
      CreateStage1RunResponse.parse({
        runId: record.runId,
        createdAt: record.createdAt,
        executionTimeMs: record.executionTimeMs,
        gridRows: record.gridRows,
        gridCols: record.gridCols,
        peakDb: record.peakDb,
        sourceX: record.sourceX,
        sourceY: record.sourceY,
        wasSourceSnapped: record.wasSourceSnapped,
        occupiedFraction: record.occupiedFraction,
        heatmapImageBase64,
        params: record.resolvedParams,
        sourceMode: record.sourceMode,
        ...(record.stage0RunId ? { stage0RunId: record.stage0RunId } : {}),
      }),
    );
  } catch (err) {
    req.log.error({ err, runId }, "Stage 1 run failed");
    const message = err instanceof Error ? err.message : "Simulation failed";
    res.status(400).json({ error: message });
  } finally {
    // The uploaded image itself is not needed once the run has completed —
    // only the derived heatmap/mask/metadata are kept for later stages.
    if (imagePath) await fs.rm(imagePath, { force: true });
  }
});

router.get("/stage1/runs", async (_req, res): Promise<void> => {
  const records = await listRunRecords();
  res.json(
    ListStage1RunsResponse.parse(
      records.map((r) => ({
        runId: r.runId,
        createdAt: r.createdAt,
        gridRows: r.gridRows,
        gridCols: r.gridCols,
        peakDb: r.peakDb,
        executionTimeMs: r.executionTimeMs,
      })),
    ),
  );
});

router.get("/stage1/runs/:runId", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const record = await loadRunRecord(runId);
  const heatmapImageBase64 = record ? await loadHeatmapBase64(runId) : null;

  if (!record || !heatmapImageBase64) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.json(
    GetStage1RunResponse.parse({
      runId: record.runId,
      createdAt: record.createdAt,
      executionTimeMs: record.executionTimeMs,
      gridRows: record.gridRows,
      gridCols: record.gridCols,
      peakDb: record.peakDb,
      sourceX: record.sourceX,
      sourceY: record.sourceY,
      sourceMode: record.sourceMode,
      ...(record.stage0RunId ? { stage0RunId: record.stage0RunId } : {}),
      wasSourceSnapped: record.wasSourceSnapped,
      occupiedFraction: record.occupiedFraction,
      heatmapImageBase64,
      params: record.resolvedParams,
    }),
  );
});

// ─── Confirm ROI ─────────────────────────────────────────────────────────────
// POST /stage1/runs/:runId/confirm-roi
// Body: { x, y, width, height } — image-pixel coordinates of the ROI rectangle.
// Crops ALL Stage 1 outputs and writes roi.json + roi_*.npy + roi_heatmap.png
// into the Stage 1 run directory.  Stage 2 reads those files exclusively.
router.post("/stage1/runs/:runId/confirm-roi", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;

  const record = await loadRunRecord(runId);
  if (!record) {
    res.status(404).json({ error: "Stage 1 run not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const x      = Number(body.x);
  const y      = Number(body.y);
  const width  = Number(body.width);
  const height = Number(body.height);

  if (
    !Number.isFinite(x) || x < 0 ||
    !Number.isFinite(y) || y < 0 ||
    !Number.isFinite(width)  || width  < 1 ||
    !Number.isFinite(height) || height < 1
  ) {
    res.status(400).json({ error: "ROI must have x, y, width, height ≥ 0 with width/height ≥ 1" });
    return;
  }

  const runDir = runDirFor(runId);

  try {
    const roiResult = await cropStage1Roi(runDir, Math.round(x), Math.round(y), Math.round(width), Math.round(height));
    req.log.info({ runId, roiResult }, "Stage 1 ROI confirmed and cropped");
    res.json({ ok: true, roi: roiResult });
  } catch (err) {
    req.log.error({ err, runId }, "Stage 1 ROI crop failed");
    const message = err instanceof Error ? err.message : "ROI crop failed";
    res.status(400).json({ error: message });
  }
});

export default router;
