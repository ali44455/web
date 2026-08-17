import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { ENGINE_DIR } from "../lib/paths";
import { logger } from "../lib/logger";

export interface Stage0Metadata {
  widthPx: number;
  heightPx: number;
  buildingCoverageFraction: number;
  roadCoverageFraction: number;
  openAreaFraction: number;
}

export interface Stage0EngineResult {
  executionTimeMs: number;
  metadata: Stage0Metadata;
}

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
const RUN_TIMEOUT_MS = 120_000;

/**
 * Runs the Stage 0 map-processing engine as a headless Python subprocess
 * against an already-saved image and writes all outputs (processed_map.png,
 * binary_mask.png, mask.npy, result.json) into `runDir`. Fully automatic —
 * no tunable parameters are accepted, matching Stage 0's "the user only
 * uploads a map" contract.
 */
export async function runStage0Engine(
  imagePath: string,
  runDir: string,
): Promise<Stage0EngineResult> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      PYTHON_BIN,
      [path.join(ENGINE_DIR, "run_stage0.py"), imagePath, runDir],
      { cwd: ENGINE_DIR },
    );

    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Map processing timed out"));
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      logger.error({ code, stderr, stdout }, "Stage 0 engine subprocess failed");
      let message = "Map processing failed";
      try {
        const parsed = JSON.parse(stderr.trim().split("\n").pop() ?? "{}");
        if (parsed.error) message = parsed.error;
      } catch {
        // stderr wasn't JSON (e.g. a Python traceback) — keep the generic message
      }
      reject(new Error(message));
    });
  });

  const resultRaw = await fs.readFile(path.join(runDir, "result.json"), "utf-8");
  return JSON.parse(resultRaw) as Stage0EngineResult;
}
