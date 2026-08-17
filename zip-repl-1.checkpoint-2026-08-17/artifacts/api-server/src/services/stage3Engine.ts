import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { ENGINE_DIR } from "../lib/paths";
import { logger } from "../lib/logger";

export interface Stage3EngineResult {
  executionTimeMs: number;
  finalNodes: [number, number][];
  coveragePercent: number;
  nodeCount: number;
  maxNodes: number;
  transmitter: [number, number];
  clusterCentroids: [number, number][];
  imageWidth: number;
  imageHeight: number;
}

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
// Budget backward elimination is fast — 30 seconds is plenty
const RUN_TIMEOUT_MS = 30_000;

async function spawnStage3(args: string[], runDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [path.join(ENGINE_DIR, "run_stage3.py"), ...args], {
      cwd: ENGINE_DIR,
    });

    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Stage 3 budget selection timed out"));
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info({ stdout, runDir }, "Stage 3 engine completed successfully");
        resolve();
        return;
      }
      logger.error({ code, stderr, stdout, runDir }, "Stage 3 engine subprocess failed");

      let message: string;
      try {
        const lastLine = stderr.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine);
        message = parsed.error ? String(parsed.error) : lastLine;
      } catch {
        message = stderr.trim() || stdout.trim() || "Stage 3 failed (no output)";
      }
      reject(new Error(message));
    });
  });
}

/**
 * Run Stage 3 budget selection against a completed Stage 2 run.
 * Reads only the persisted cropped Stage 2 artifacts from stage2RunDir;
 * writes outputs to runDir. The stage1RunDir argument is retained for API
 * compatibility but is not read by the engine.
 */
export async function runStage3Engine(
  stage2RunDir: string,
  maxNodes: number,
  stage1RunDir: string,
  runDir: string,
): Promise<Stage3EngineResult> {
  await spawnStage3([stage2RunDir, String(maxNodes), stage1RunDir, runDir], runDir);

  const raw = await fs.readFile(path.join(runDir, "result.json"), "utf-8");
  return JSON.parse(raw) as Stage3EngineResult;
}
