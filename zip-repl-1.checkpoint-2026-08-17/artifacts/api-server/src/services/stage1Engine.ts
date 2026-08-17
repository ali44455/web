import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { ENGINE_DIR } from "../lib/paths";
import { logger } from "../lib/logger";

export interface Stage1FormFields {
  cellSizeMeters?: number;
  realWidthMeters?: number;
  frequencyMHz?: number;
  refractiveIndex?: number;
  absorptionCoeff?: number;
  sourceValue?: number;
  minDb?: number;
  pmlWidth?: number;
  pmlMaxLoss?: number;
  alpha3dBump?: number;
  sourceXPercent?: number;
  sourceYPercent?: number;
  cellBudget?: number;
}

export interface Stage1ResolvedParams {
  cellSizeMeters: number;
  frequencyMHz: number;
  refractiveIndex: number;
  absorptionCoeff: number;
  sourceValue: number;
  minDb: number;
  pmlWidth: number;
  pmlMaxLoss: number;
  alpha3dBump: number;
  sourceXPercent: number;
  sourceYPercent: number;
  cellBudget: number;
}

export interface HeatmapDataRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Stage1EngineResult {
  gridRows: number;
  gridCols: number;
  executionTimeMs: number;
  peakDb: number;
  sourceX: number;
  sourceY: number;
  wasSourceSnapped: boolean;
  occupiedFraction: number;
  heatmapDataRect: HeatmapDataRect;
  sourceMode: "stage0" | "raw";
  resolvedParams: Stage1ResolvedParams;
}

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
// Wall-clock cap for a single simulation run, to avoid a runaway subprocess
// hanging an HTTP request forever on pathological inputs.
const RUN_TIMEOUT_MS = 600_000;

// ─── ROI crop ─────────────────────────────────────────────────────────────────

export interface RoiCropResult {
  x: number;
  y: number;
  width: number;
  height: number;
  x0Grid: number;
  y0Grid: number;
  x1Grid: number;
  y1Grid: number;
  croppedGridCols: number;
  croppedGridRows: number;
  srcXCropped: number;
  srcYCropped: number;
}

/**
 * Crops ALL Stage 1 outputs (mag_db.npy, map_mask.npy, heatmap.png,
 * campus_map.png) to the given image-pixel rectangle and writes them plus
 * roi.json into the Stage 1 run directory.
 *
 * Stage 2 reads these pre-cropped files exclusively — it never re-derives
 * them from the original map or the full-size heatmap.
 */
export async function cropStage1Roi(
  runDir: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<RoiCropResult> {
  return new Promise<RoiCropResult>((resolve, reject) => {
    const child = spawn(
      PYTHON_BIN,
      [
        path.join(ENGINE_DIR, "crop_stage1_roi.py"),
        runDir,
        String(Math.round(x)),
        String(Math.round(y)),
        String(Math.round(width)),
        String(Math.round(height)),
      ],
      { cwd: ENGINE_DIR },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ROI crop timed out"));
    }, 30_000);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const lastLine = stdout.trim().split("\n").pop() ?? "";
          const parsed = JSON.parse(lastLine);
          if (!parsed.ok) throw new Error("Unexpected ROI crop output");
          logger.info({ runDir }, "ROI crop completed successfully");
          resolve(parsed.roi as RoiCropResult);
        } catch (parseErr) {
          reject(new Error(`ROI crop parse error: ${parseErr}`));
        }
        return;
      }
      logger.error({ code, stderr, stdout, runDir }, "ROI crop subprocess failed");
      let message: string;
      try {
        const lastLine = stderr.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine);
        message = parsed.error ? String(parsed.error) : lastLine;
      } catch {
        message = stderr.trim() || stdout.trim() || "ROI crop failed (no output)";
      }
      reject(new Error(message));
    });
  });
}

async function spawnStage1(args: string[], runDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [path.join(ENGINE_DIR, "run_stage1.py"), ...args], {
      cwd: ENGINE_DIR,
    });

    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Simulation timed out"));
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
        logger.info({ stdout, runDir }, "Stage 1 engine completed successfully");
        resolve();
        return;
      }
      logger.error({ code, stderr, stdout, runDir }, "Stage 1 engine subprocess failed");

      // Attempt to extract a structured error from the last JSON line the
      // Python script writes to stderr.  If that fails (e.g. it's a raw
      // Python traceback from an unhandled import error), surface the FULL
      // stderr so the caller — and the HTTP response — contain the real cause
      // rather than a generic placeholder.
      let message: string;
      try {
        const lastLine = stderr.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine);
        message = parsed.error ? String(parsed.error) : lastLine;
      } catch {
        // stderr is a plain Python traceback — expose it verbatim
        message = stderr.trim() || stdout.trim() || "Simulation failed (no output)";
      }
      reject(new Error(message));
    });
  });
}

/**
 * Stage 0 mode: consumes a prior Stage 0 run's canonical mask + processed
 * map directly (never re-reads the original upload). The scientific
 * computation (sparse FDFD solve) has no faithful JS equivalent, so the
 * original Python algorithm is preserved and invoked directly rather than
 * reimplemented in TypeScript.
 */
export async function runStage1EngineFromStage0(
  maskPath: string,
  processedMapPath: string,
  fields: Stage1FormFields,
  runDir: string,
): Promise<Stage1EngineResult> {
  const paramsPath = path.join(runDir, "params.json");
  await fs.writeFile(paramsPath, JSON.stringify(fields));

  await spawnStage1(["stage0", maskPath, processedMapPath, paramsPath, runDir], runDir);

  const resultRaw = await fs.readFile(path.join(runDir, "result.json"), "utf-8");
  return JSON.parse(resultRaw) as Stage1EngineResult;
}

/**
 * Raw mode (Workflow A — "Simulation Ready Map"): the user has explicitly
 * chosen to upload a map that is already in the simulator's native format.
 * No automatic format detection or rejection happens here.
 */
export async function runStage1EngineFromRawImage(
  imagePath: string,
  fields: Stage1FormFields,
  runDir: string,
): Promise<Stage1EngineResult> {
  const paramsPath = path.join(runDir, "params.json");
  await fs.writeFile(paramsPath, JSON.stringify(fields));

  await spawnStage1(["raw", imagePath, paramsPath, runDir], runDir);

  const resultRaw = await fs.readFile(path.join(runDir, "result.json"), "utf-8");
  return JSON.parse(resultRaw) as Stage1EngineResult;
}
