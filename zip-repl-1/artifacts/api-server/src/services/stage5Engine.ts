import { spawn } from "child_process";
import path from "path";
import { ENGINE_DIR } from "../lib/paths";

const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

export function runStage5Engine(
  stage1Dir: string,
  stage2Dir: string,
  stage4Dir: string,
  outputDir: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [
      path.join(ENGINE_DIR, "run_stage5.py"),
      stage1Dir,
      stage2Dir,
      stage4Dir,
      outputDir,
    ], { cwd: ENGINE_DIR });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Engineering analysis timed out"));
    }, 120_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim().split("\n").pop() || "Engineering analysis failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop() || "{}"));
      } catch {
        reject(new Error("Analysis engine returned invalid output"));
      }
    });
  });
}
