import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { ENGINE_DIR } from "../lib/paths";
import { logger } from "../lib/logger";

export interface Stage2EngineResult {
  executionTimeMs: number;
  finalNodes: [number, number][];
  candidateLocations: [number, number][];
  clusterCentroids: [number, number][];
  coveragePercent: number;
  nodeCount: number;
  numClusters: number;
  bestExclusionRadius: number;
  nodeCoverageRadius: number;
  deadZoneThresholdDbm: number;
  deadZonePercentile: number;
  transmitter: [number, number];
  imageWidth: number;
  imageHeight: number;
}

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
// Node placement ILP can take up to 3 minutes on dense maps
const RUN_TIMEOUT_MS = 180_000;

async function spawnStage2(args: string[], runDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [path.join(ENGINE_DIR, "run_stage2.py"), ...args], {
      cwd: ENGINE_DIR,
    });

    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Stage 2 optimization timed out"));
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info({ stdout, runDir }, "Stage 2 engine completed successfully");
        resolve();
        return;
      }
      logger.error({ code, stderr, stdout, runDir }, "Stage 2 engine subprocess failed");

      let message: string;
      try {
        const lastLine = stderr.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine);
        message = parsed.error ? String(parsed.error) : lastLine;
      } catch {
        message = stderr.trim() || stdout.trim() || "Stage 2 failed (no output)";
      }
      reject(new Error(message));
    });
  });
}

/**
 * Run Stage 2 node placement against a completed Stage 1 run directory.
 * Reads mag_db.npy, map_mask.npy, heatmap.png and result.json from
 * stage1RunDir; writes outputs to runDir.
 */
export interface HeatmapRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function runStage2Engine(
  stage1RunDir: string,
  runDir: string,
): Promise<Stage2EngineResult> {
  // Stage 2 reads roi.json + roi_*.npy directly from stage1RunDir.
  // ROI must already be confirmed via POST /stage1/runs/:runId/confirm-roi
  // before this function is called — run_stage2.py will abort if roi.json
  // is missing.
  await spawnStage2([stage1RunDir, runDir], runDir);

  const raw = await fs.readFile(path.join(runDir, "result.json"), "utf-8");
  return JSON.parse(raw) as Stage2EngineResult;
}
