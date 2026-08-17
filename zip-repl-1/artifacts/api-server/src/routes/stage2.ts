import { Router, type IRouter } from "express";
import fs from "fs/promises";
import path from "path";
import { CreateStage2RunBody } from "@workspace/api-zod";
import {
  createRunDir,
  saveStage2RunRecord,
  loadStage2RunRecord,
  loadVisualizationBase64,
  runDirFor,
  loadRunRecord,
  type HeatmapRoi,
} from "../services/runStore";
import { runStage2Engine } from "../services/stage2Engine";

const router: IRouter = Router();

router.post("/stage2/runs", async (req, res): Promise<void> => {
  const parsed = CreateStage2RunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stage1RunId } = parsed.data;

  // Verify the Stage 1 run exists
  const stage1Record = await loadRunRecord(stage1RunId);
  if (!stage1Record) {
    res.status(400).json({ error: `Stage 1 run '${stage1RunId}' not found` });
    return;
  }

  const stage1RunDir = runDirFor(stage1RunId);

  // Require a confirmed ROI — run_stage2.py will also abort without roi.json,
  // but we surface a friendlier error here first.
  const roiJsonPath = path.join(stage1RunDir, "roi.json");
  let roi: HeatmapRoi | undefined;
  try {
    const roiRaw = await fs.readFile(roiJsonPath, "utf-8");
    const roiData = JSON.parse(roiRaw) as Record<string, number>;
    roi = {
      x: roiData.x,
      y: roiData.y,
      width: roiData.width,
      height: roiData.height,
    };
  } catch {
    res.status(400).json({
      error:
        "ROI not confirmed for this Stage 1 run. " +
        "Please draw an ROI on the heatmap and click 'Confirm ROI' before starting Stage 2.",
    });
    return;
  }

  const { runId, runDir } = await createRunDir();

  try {
    req.log.info({ stage1RunId, runId, roi }, "Starting Stage 2 node placement");
    const engineResult = await runStage2Engine(stage1RunDir, runDir);

    const record = await saveStage2RunRecord(runId, runDir, engineResult, stage1RunId, roi);
    const visualizationBase64 = await loadVisualizationBase64(runId);

    if (!visualizationBase64) {
      req.log.error({ runId }, "Stage 2 visualization missing after successful run");
      res.status(500).json({ error: "Stage 2 completed but the visualization could not be read" });
      return;
    }

    res.status(201).json({
      runId: record.runId,
      createdAt: record.createdAt,
      stage1RunId: record.stage1RunId,
      executionTimeMs: record.executionTimeMs,
      finalNodes: record.finalNodes,
      candidateLocations: record.candidateLocations,
      clusterCentroids: record.clusterCentroids,
      coveragePercent: record.coveragePercent,
      nodeCount: record.nodeCount,
      numClusters: record.numClusters,
      bestExclusionRadius: record.bestExclusionRadius,
      nodeCoverageRadius: record.nodeCoverageRadius,
      transmitter: record.transmitter,
      imageWidth: record.imageWidth,
      imageHeight: record.imageHeight,
      roi: record.roi ?? null,
      visualizationImageBase64: visualizationBase64,
    });
  } catch (err) {
    req.log.error({ err, runId, stage1RunId }, "Stage 2 run failed");
    const message = err instanceof Error ? err.message : "Stage 2 optimization failed";
    res.status(400).json({ error: message });
  }
});

router.get("/stage2/runs/:runId", async (req, res): Promise<void> => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
  const record = await loadStage2RunRecord(runId);
  const visualizationBase64 = record ? await loadVisualizationBase64(runId) : null;

  if (!record || !visualizationBase64) {
    res.status(404).json({ error: "Stage 2 run not found" });
    return;
  }

  res.json({
    runId: record.runId,
    createdAt: record.createdAt,
    stage1RunId: record.stage1RunId,
    executionTimeMs: record.executionTimeMs,
    finalNodes: record.finalNodes,
    candidateLocations: record.candidateLocations,
    clusterCentroids: record.clusterCentroids,
    coveragePercent: record.coveragePercent,
    nodeCount: record.nodeCount,
    numClusters: record.numClusters,
    bestExclusionRadius: record.bestExclusionRadius,
    nodeCoverageRadius: record.nodeCoverageRadius,
    transmitter: record.transmitter,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    roi: record.roi ?? null,
    visualizationImageBase64: visualizationBase64,
  });
});

export default router;
