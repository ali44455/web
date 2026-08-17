import { Router, type IRouter } from "express";
import { CreateStage3RunBody } from "@workspace/api-zod";
import {
  createRunDir,
  saveStage3RunRecord,
  loadStage3RunRecord,
  loadVisualizationBase64,
  runDirFor,
  loadStage2RunRecord,
  loadRunRecord,
} from "../services/runStore";
import { runStage3Engine } from "../services/stage3Engine";

const router: IRouter = Router();

router.post("/stage3/runs", async (req, res): Promise<void> => {
  const parsed = CreateStage3RunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stage2RunId, maxNodes } = parsed.data;

  // Verify the Stage 2 run exists
  const stage2Record = await loadStage2RunRecord(stage2RunId);
  if (!stage2Record) {
    res.status(400).json({ error: `Stage 2 run '${stage2RunId}' not found` });
    return;
  }

  // Also need the Stage 1 run dir (for the heatmap image used in visualization)
  const stage1Record = await loadRunRecord(stage2Record.stage1RunId);
  if (!stage1Record) {
    res.status(400).json({ error: `Stage 1 run '${stage2Record.stage1RunId}' not found` });
    return;
  }

  const stage2RunDir = runDirFor(stage2RunId);
  const stage1RunDir = runDirFor(stage2Record.stage1RunId);
  const { runId, runDir } = await createRunDir();

  try {
    req.log.info({ stage2RunId, maxNodes, runId }, "Starting Stage 3 budget selection");
    const engineResult = await runStage3Engine(stage2RunDir, maxNodes, stage1RunDir, runDir);

    const record = await saveStage3RunRecord(runId, runDir, engineResult, stage2RunId);
    const visualizationBase64 = await loadVisualizationBase64(runId);

    if (!visualizationBase64) {
      req.log.error({ runId }, "Stage 3 visualization missing after successful run");
      res.status(500).json({ error: "Stage 3 completed but the visualization could not be read" });
      return;
    }

    res.status(201).json({
      runId: record.runId,
      createdAt: record.createdAt,
      stage2RunId: record.stage2RunId,
      executionTimeMs: record.executionTimeMs,
      finalNodes: record.finalNodes,
      coveragePercent: record.coveragePercent,
      nodeCount: record.nodeCount,
      maxNodes: record.maxNodes,
      transmitter: record.transmitter,
      clusterCentroids: record.clusterCentroids,
      imageWidth: record.imageWidth,
      imageHeight: record.imageHeight,
      visualizationImageBase64: visualizationBase64,
    });
  } catch (err) {
    req.log.error({ err, runId, stage2RunId }, "Stage 3 run failed");
    const message = err instanceof Error ? err.message : "Stage 3 budget selection failed";
    res.status(400).json({ error: message });
  }
});

router.get("/stage3/runs/:runId", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const record = await loadStage3RunRecord(runId);
  const visualizationBase64 = record ? await loadVisualizationBase64(runId) : null;

  if (!record || !visualizationBase64) {
    res.status(404).json({ error: "Stage 3 run not found" });
    return;
  }

  res.json({
    runId: record.runId,
    createdAt: record.createdAt,
    stage2RunId: record.stage2RunId,
    executionTimeMs: record.executionTimeMs,
    finalNodes: record.finalNodes,
    coveragePercent: record.coveragePercent,
    nodeCount: record.nodeCount,
    maxNodes: record.maxNodes,
    transmitter: record.transmitter,
    clusterCentroids: record.clusterCentroids,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    visualizationImageBase64: visualizationBase64,
  });
});

export default router;
