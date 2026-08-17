import { Router, type IRouter } from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import {
  CreateStage0RunResponse,
  ListStage0RunsResponse,
  GetStage0RunResponse,
} from "@workspace/api-zod";
import { runStage0Engine } from "../services/stage0Engine";
import {
  createRunDir,
  saveStage0RunRecord,
  loadStage0RunRecord,
  loadProcessedMapBase64,
  loadBinaryMaskBase64,
  listStage0RunRecords,
} from "../services/runStore";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post("/stage0/runs", upload.single("map"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "Missing 'map' image file" });
    return;
  }

  const { runId, runDir } = await createRunDir();
  const imagePath = path.join(runDir, "map-source");

  try {
    await fs.writeFile(imagePath, req.file.buffer);

    const engineResult = await runStage0Engine(imagePath, runDir);
    const record = await saveStage0RunRecord(runId, runDir, engineResult);
    const [processedMapImageBase64, binaryMaskImageBase64] = await Promise.all([
      loadProcessedMapBase64(runId),
      loadBinaryMaskBase64(runId),
    ]);

    if (!processedMapImageBase64 || !binaryMaskImageBase64) {
      req.log.error({ runId }, "Stage 0 outputs missing after successful run");
      res.status(500).json({ error: "Map processing completed but its outputs could not be read" });
      return;
    }

    res.status(201).json(
      CreateStage0RunResponse.parse({
        runId: record.runId,
        createdAt: record.createdAt,
        executionTimeMs: record.executionTimeMs,
        processedMapImageBase64,
        binaryMaskImageBase64,
        metadata: record.metadata,
      }),
    );
  } catch (err) {
    req.log.error({ err, runId }, "Stage 0 run failed");
    const message = err instanceof Error ? err.message : "Map processing failed";
    res.status(400).json({ error: message });
  } finally {
    // The uploaded image itself is not needed once processing completes —
    // only the derived Processed_Map/BinaryMask/metadata are kept.
    await fs.rm(imagePath, { force: true });
  }
});

router.get("/stage0/runs", async (_req, res): Promise<void> => {
  const records = await listStage0RunRecords();
  res.json(
    ListStage0RunsResponse.parse(
      records.map((r) => ({
        runId: r.runId,
        createdAt: r.createdAt,
        executionTimeMs: r.executionTimeMs,
        metadata: r.metadata,
      })),
    ),
  );
});

router.get("/stage0/runs/:runId", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const record = await loadStage0RunRecord(runId);
  const [processedMapImageBase64, binaryMaskImageBase64] = record
    ? await Promise.all([loadProcessedMapBase64(runId), loadBinaryMaskBase64(runId)])
    : [null, null];

  if (!record || !processedMapImageBase64 || !binaryMaskImageBase64) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.json(
    GetStage0RunResponse.parse({
      runId: record.runId,
      createdAt: record.createdAt,
      executionTimeMs: record.executionTimeMs,
      processedMapImageBase64,
      binaryMaskImageBase64,
      metadata: record.metadata,
    }),
  );
});

export default router;
