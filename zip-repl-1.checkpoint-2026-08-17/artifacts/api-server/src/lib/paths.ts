import path from "path";
import { fileURLToPath } from "url";

// This file is bundled (by esbuild) into a single artifacts/api-server/dist/index.mjs
// at runtime, so import.meta.url always resolves inside .../api-server/dist.
// Go up one level to get the package root.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// In production this module is bundled under `dist/`; during local TS
// development tsx loads it from `src/lib/`. Resolve both layouts to the
// API package root so Python engines and persisted runs are found reliably.
const packageRoot = path.basename(moduleDir) === "dist"
  ? path.resolve(moduleDir, "..")
  : path.resolve(moduleDir, "../..");

export const ENGINE_DIR = path.join(packageRoot, "engine");
export const RUNS_DIR = path.join(packageRoot, "data", "runs");
