import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import readline from "readline";
import type { IncomingMessage } from "http";
import { ENGINE_DIR } from "../lib/paths";
import { logger } from "../lib/logger";

export interface Stage4Params {
  realWidth: number;
  realHeight: number;
  freqHz: number;
  txPowerDbm?: number;
  alphaAir?: number;
  alphaEff?: number;
  refractiveIndex?: number;
  pmlWidth?: number;
  pmlMaxLoss?: number;
  alpha3dBump?: number;
  targetRssiThreshold?: number;
  nIterations?: number;
  stepAngle?: number;
  antennaXMeters: number;
  antennaYMeters: number;
  /** Final node positions in ROI-cropped pixel coordinates [x, y] */
  finalNodes: [number, number][];
}

export interface Stage4EngineResult {
  executionTimeMs: number;
  totalFrames: number;
  nodeCount: number;
  weakNodeCount: number;
  unreachableCount: number;
  nIterations: number;
  freqHz: number;
  txPowerDbm: number;
  targetRssiThreshold: number;
  stepAngle: number;
  antennaXMeters: number;
  antennaYMeters: number;
  realWidth: number;
  realHeight: number;
  videoFilename: string | null;
  videoAvailable: boolean;
}

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
// Stage 4 can take up to 10 minutes for full precomputation
const RUN_TIMEOUT_MS = 1_800_000;

/**
 * Stream Stage 4 phased-array simulation, piping Python stdout JSON-lines
 * directly to an SSE response. Resolves when the Python process exits cleanly.
 *
 * The caller is responsible for setting SSE headers before calling this.
 * Each JSON line from Python is sent as an SSE `data:` event.
 */
export async function streamStage4Engine(
  stage1RunDir: string,
  stage2RunDir: string,
  outputDir: string,
  params: Stage4Params,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<Stage4EngineResult> {
  const paramsPath = path.join(outputDir, "stage4-params.json");
  await fs.writeFile(paramsPath, JSON.stringify(params));

  return new Promise<Stage4EngineResult>((resolve, reject) => {
    const child = spawn(
      PYTHON_BIN,
      [path.join(ENGINE_DIR, "run_stage4.py"), stage1RunDir, stage2RunDir, outputDir, paramsPath],
      { cwd: ENGINE_DIR },
    );

    let lastDonePayload: Stage4EngineResult | null = null;
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Stage 4 simulation timed out"));
    }, RUN_TIMEOUT_MS);

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      onLine(line);
      try {
        const obj = JSON.parse(line);
        if (obj.type === "done") {
          lastDonePayload = obj as Stage4EngineResult;
        }
      } catch {
        // non-JSON stdout — ignore
      }
    });

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    if (signal) {
      signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });
    }

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && lastDonePayload) {
        logger.info({ outputDir }, "Stage 4 engine completed successfully");
        resolve(lastDonePayload);
        return;
      }
      logger.error({ code, stderr, outputDir }, "Stage 4 engine subprocess failed");
      let message: string;
      try {
        const lastLine = stderr.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine);
        message = parsed.error ? String(parsed.error) : lastLine;
      } catch {
        message = stderr.trim() || "Stage 4 failed (no output)";
      }
      reject(new Error(message));
    });
  });
}
