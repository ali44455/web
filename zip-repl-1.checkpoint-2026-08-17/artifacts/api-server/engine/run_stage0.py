"""
CLI entry point invoked by the Node API server as a subprocess. Reads a raw
map image, runs the Stage 0 map-processing pipeline (stage0_engine.run),
and writes:
  - Processed_Map.png (processed_map.png) — standardized clean rendering
  - BinaryMask.png (binary_mask.png) — human-viewable mask rendering
  - mask.npy — lossless boolean building mask at canonical resolution (this
    is what Stage 1 actually loads; the PNG is a lossy preview)
  - result.json — metadata

Usage:
  python3 run_stage0.py <image_path> <output_dir>

On success: exits 0, writes <output_dir>/result.json.
On failure: exits 1, writes a JSON error to stderr.
"""

import json
import sys

# Windows may default subprocess output to a legacy code page.  The API streams
# progress messages containing engineering symbols, so force a safe UTF-8 pipe.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
from PIL import Image

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import stage0_engine


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error": "usage: run_stage0.py <image> <output_dir>"}), file=sys.stderr)
        sys.exit(1)

    image_path, output_dir = sys.argv[1], sys.argv[2]

    try:
        pil_img = Image.open(image_path).convert("RGB")
        raw_image = np.array(pil_img)

        result = stage0_engine.run(raw_image)

        Image.fromarray(result["processed_map"]).save(f"{output_dir}/processed_map.png")
        Image.fromarray(result["binary_mask_png"]).save(f"{output_dir}/binary_mask.png")
        np.save(f"{output_dir}/mask.npy", result["building_mask"])

        metadata = {
            "executionTimeMs": result["execution_time_ms"],
            "metadata": result["metadata"],
        }
        with open(f"{output_dir}/result.json", "w") as f:
            json.dump(metadata, f)

        print(json.dumps({"ok": True}))
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001 - report any failure back to the caller
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
