import { Router, type IRouter } from "express";
import fs from "fs/promises";
import path from "path";
import { createRunDir, runDirFor, loadStage2RunRecord } from "../services/runStore";
import { runStage5Engine } from "../services/stage5Engine";

const router: IRouter = Router();
const allowedCharts = new Set([
  "analysis_beam_sweeping.png",
  "analysis_path_loss.png",
  "analysis_array_gain.png",
  "analysis_signal_quality.png",
  "analysis_tradeoff_3d.png",
  "analysis_phase_delay.png",
  "analysis_phase_tolerance.png",
]);

async function withImages(runDir: string, record: any) {
  const chartImages: Record<string, string> = {};
  for (const [key, filename] of Object.entries(record.chartFiles ?? {})) {
    if (!allowedCharts.has(String(filename))) continue;
    try {
      const bytes = await fs.readFile(path.join(runDir, String(filename)));
      chartImages[key] = `data:image/png;base64,${bytes.toString("base64")}`;
    } catch { /* optional chart */ }
  }
  return { ...record, chartImages };
}

router.post("/stage5/runs", async (req, res): Promise<void> => {
  const stage4RunId = String(req.body?.stage4RunId ?? "");
  if (!stage4RunId) {
    res.status(400).json({ error: "stage4RunId is required" });
    return;
  }
  const stage4Dir = runDirFor(stage4RunId);
  try {
    await fs.access(path.join(stage4Dir, "result.json"));
    await fs.access(path.join(stage4Dir, "max_hold_db.npy"));
    const pending = JSON.parse(await fs.readFile(path.join(stage4Dir, "stage4-pending.json"), "utf-8"));
    const stage2RunId = String(pending.stage2RunId);
    const stage2 = await loadStage2RunRecord(stage2RunId);
    if (!stage2) throw new Error("Linked Stage 2 run is missing");
    const { runId, runDir } = await createRunDir();
    const result = await runStage5Engine(
      runDirFor(stage2.stage1RunId),
      runDirFor(stage2RunId),
      stage4Dir,
      runDir,
    );
    const record = {
      ...result,
      runId,
      createdAt: new Date().toISOString(),
      stage1RunId: stage2.stage1RunId,
      stage2RunId,
      stage4RunId,
    };
    await fs.writeFile(path.join(runDir, "stage5-run.json"), JSON.stringify(record));
    res.status(201).json(await withImages(runDir, record));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Analysis failed" });
  }
});

router.get("/stage5/runs/:runId", async (req, res): Promise<void> => {
  try {
    const runId = String(req.params.runId);
    const runDir = runDirFor(runId);
    const record = JSON.parse(await fs.readFile(path.join(runDir, "stage5-run.json"), "utf-8"));
    res.json(await withImages(runDir, record));
  } catch {
    res.status(404).json({ error: "Engineering analysis run not found" });
  }
});

router.get("/stage5/runs/:runId/export", async (req, res): Promise<void> => {
  try {
    const runId = String(req.params.runId);
    const record = JSON.parse(await fs.readFile(path.join(runDirFor(runId), "stage5-run.json"), "utf-8"));
    res.setHeader("Content-Disposition", `attachment; filename="engineering-analysis-${runId}.json"`);
    res.json(record);
  } catch {
    res.status(404).json({ error: "Engineering analysis export not found" });
  }
});

export default router;
