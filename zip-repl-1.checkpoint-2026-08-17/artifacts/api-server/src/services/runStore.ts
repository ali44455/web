import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { RUNS_DIR } from "../lib/paths";
import type { Stage1EngineResult } from "./stage1Engine";
import type { Stage0EngineResult } from "./stage0Engine";
import type { Stage2EngineResult } from "./stage2Engine";
import type { Stage3EngineResult } from "./stage3Engine";

export interface Stage1RunRecord extends Stage1EngineResult {
  runId: string;
  createdAt: string;
  stage0RunId?: string;
}

export interface Stage0RunRecord extends Stage0EngineResult {
  runId: string;
  createdAt: string;
}

const RUN_RECORD_FILE = "run.json";
const STAGE0_RUN_RECORD_FILE = "stage0-run.json";
const HEATMAP_FILE = "heatmap.png";
const PROCESSED_MAP_FILE = "processed_map.png";
const BINARY_MASK_FILE = "binary_mask.png";
const CANONICAL_MASK_FILE = "mask.npy";

/** Creates a fresh, empty directory for a new run and returns its id + path. */
export async function createRunDir(): Promise<{ runId: string; runDir: string }> {
  const runId = randomUUID();
  const runDir = path.join(RUNS_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

export function runDirFor(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

export async function saveRunRecord(
  runId: string,
  runDir: string,
  engineResult: Stage1EngineResult,
  stage0RunId?: string,
): Promise<Stage1RunRecord> {
  const record: Stage1RunRecord = {
    ...engineResult,
    runId,
    createdAt: new Date().toISOString(),
    ...(stage0RunId ? { stage0RunId } : {}),
  };
  await fs.writeFile(
    path.join(runDir, RUN_RECORD_FILE),
    JSON.stringify(record),
  );
  return record;
}

export async function loadRunRecord(
  runId: string,
): Promise<Stage1RunRecord | null> {
  try {
    const runDir = runDirFor(runId);
    const raw = await fs.readFile(path.join(runDir, RUN_RECORD_FILE), "utf-8");
    return JSON.parse(raw) as Stage1RunRecord;
  } catch {
    return null;
  }
}

export async function loadHeatmapBase64(runId: string): Promise<string | null> {
  try {
    const runDir = runDirFor(runId);
    const png = await fs.readFile(path.join(runDir, HEATMAP_FILE));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function listRunRecords(): Promise<Stage1RunRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(RUNS_DIR);
  } catch {
    return [];
  }

  const records = await Promise.all(entries.map((runId) => loadRunRecord(runId)));
  return records
    .filter((r): r is Stage1RunRecord => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --- Stage 0 -----------------------------------------------------------

export async function saveStage0RunRecord(
  runId: string,
  runDir: string,
  engineResult: Stage0EngineResult,
): Promise<Stage0RunRecord> {
  const record: Stage0RunRecord = {
    ...engineResult,
    runId,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(runDir, STAGE0_RUN_RECORD_FILE),
    JSON.stringify(record),
  );
  return record;
}

export async function loadStage0RunRecord(
  runId: string,
): Promise<Stage0RunRecord | null> {
  try {
    const runDir = runDirFor(runId);
    const raw = await fs.readFile(path.join(runDir, STAGE0_RUN_RECORD_FILE), "utf-8");
    return JSON.parse(raw) as Stage0RunRecord;
  } catch {
    return null;
  }
}

async function loadRunImageBase64(runDir: string, fileName: string): Promise<string | null> {
  try {
    const png = await fs.readFile(path.join(runDir, fileName));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function loadProcessedMapBase64(runId: string): Promise<string | null> {
  return loadRunImageBase64(runDirFor(runId), PROCESSED_MAP_FILE);
}

export async function loadBinaryMaskBase64(runId: string): Promise<string | null> {
  return loadRunImageBase64(runDirFor(runId), BINARY_MASK_FILE);
}

/** Absolute path to a Stage 0 run's canonical mask.npy, for handing to the
 * Stage 1 subprocess (Node never reads/parses the array itself). */
export function stage0MaskPathFor(runId: string): string {
  return path.join(runDirFor(runId), CANONICAL_MASK_FILE);
}

/** Absolute path to a Stage 0 run's Processed_Map.png, for handing to the
 * Stage 1 subprocess as its render background. */
export function stage0ProcessedMapPathFor(runId: string): string {
  return path.join(runDirFor(runId), PROCESSED_MAP_FILE);
}

export async function stage0RunExists(runId: string): Promise<boolean> {
  const record = await loadStage0RunRecord(runId);
  return record !== null;
}

export async function listStage0RunRecords(): Promise<Stage0RunRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(RUNS_DIR);
  } catch {
    return [];
  }

  const records = await Promise.all(entries.map((runId) => loadStage0RunRecord(runId)));
  return records
    .filter((r): r is Stage0RunRecord => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --- Stage 2 -----------------------------------------------------------

const STAGE2_RUN_RECORD_FILE = "stage2-run.json";
const VISUALIZATION_FILE = "visualization.png";

export interface HeatmapRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Stage2RunRecord extends Stage2EngineResult {
  runId: string;
  createdAt: string;
  stage1RunId: string;
  roi?: HeatmapRoi;
}

export async function saveStage2RunRecord(
  runId: string,
  runDir: string,
  engineResult: Stage2EngineResult,
  stage1RunId: string,
  roi?: HeatmapRoi,
): Promise<Stage2RunRecord> {
  const record: Stage2RunRecord = {
    ...engineResult,
    runId,
    createdAt: new Date().toISOString(),
    stage1RunId,
    ...(roi ? { roi } : {}),
  };
  await fs.writeFile(path.join(runDir, STAGE2_RUN_RECORD_FILE), JSON.stringify(record));
  return record;
}

export async function loadStage2RunRecord(runId: string): Promise<Stage2RunRecord | null> {
  try {
    const raw = await fs.readFile(path.join(runDirFor(runId), STAGE2_RUN_RECORD_FILE), "utf-8");
    return JSON.parse(raw) as Stage2RunRecord;
  } catch {
    return null;
  }
}

export async function loadVisualizationBase64(runId: string): Promise<string | null> {
  try {
    const png = await fs.readFile(path.join(runDirFor(runId), VISUALIZATION_FILE));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

// --- Stage 3 -----------------------------------------------------------

const STAGE3_RUN_RECORD_FILE = "stage3-run.json";

export interface Stage3RunRecord extends Stage3EngineResult {
  runId: string;
  createdAt: string;
  stage2RunId: string;
}

export async function saveStage3RunRecord(
  runId: string,
  runDir: string,
  engineResult: Stage3EngineResult,
  stage2RunId: string,
): Promise<Stage3RunRecord> {
  const record: Stage3RunRecord = {
    ...engineResult,
    runId,
    createdAt: new Date().toISOString(),
    stage2RunId,
  };
  await fs.writeFile(path.join(runDir, STAGE3_RUN_RECORD_FILE), JSON.stringify(record));
  return record;
}

export async function loadStage3RunRecord(runId: string): Promise<Stage3RunRecord | null> {
  try {
    const raw = await fs.readFile(path.join(runDirFor(runId), STAGE3_RUN_RECORD_FILE), "utf-8");
    return JSON.parse(raw) as Stage3RunRecord;
  } catch {
    return null;
  }
}
