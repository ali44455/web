"""
crop_stage1_roi.py — Confirm and persist an ROI for a Stage 1 run.

Crops ALL Stage 1 outputs to the given rectangle (heatmap-image pixel coords)
and writes the cropped versions + roi.json into the Stage 1 run directory.

Stage 2 reads these pre-cropped files directly — it never asks for an ROI arg.

Output files written to <stage1_run_dir>/:
  roi.json           — confirmed ROI + grid-space crop coordinates
  roi_mag_db.npy     — cropped signal matrix
  roi_map_mask.npy   — cropped binary mask
  roi_heatmap.png    — cropped heatmap (pure data area, no colorbar)
  roi_campus_map.png — cropped campus image (if original exists)

Usage:
  python3 crop_stage1_roi.py <stage1_run_dir> <x> <y> <width> <height>

Writes compact JSON to stdout on success; JSON {"error":"..."} to stderr + exit 1
on failure.
"""

import json
import os
import sys
import traceback

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
from PIL import Image


def _log(msg):
    print(f"[crop_roi] {msg}", file=sys.stderr, flush=True)


def main():
    if len(sys.argv) != 6:
        print(
            json.dumps({"error":
                f"Usage: {sys.argv[0]} stage1_run_dir x y width height"}),
            file=sys.stderr,
        )
        sys.exit(1)

    stage1_dir = sys.argv[1]
    try:
        roi_x = int(float(sys.argv[2]))
        roi_y = int(float(sys.argv[3]))
        roi_w = int(float(sys.argv[4]))
        roi_h = int(float(sys.argv[5]))
    except ValueError as e:
        print(json.dumps({"error": f"ROI values must be integers: {e}"}), file=sys.stderr)
        sys.exit(1)

    if roi_w < 1 or roi_h < 1:
        print(json.dumps({"error": "ROI width and height must be ≥ 1"}), file=sys.stderr)
        sys.exit(1)

    try:
        # ── Load Stage 1 metadata ─────────────────────────────────────────────
        result_path = os.path.join(stage1_dir, "result.json")
        with open(result_path) as f:
            s1 = json.load(f)

        grid_rows = int(s1["gridRows"])
        grid_cols = int(s1["gridCols"])
        src_x     = int(s1["sourceX"])
        src_y     = int(s1["sourceY"])

        # ── Load heatmap to get image dimensions ──────────────────────────────
        heatmap_path = os.path.join(stage1_dir, "heatmap.png")
        heatmap_pil  = Image.open(heatmap_path)
        img_w, img_h = heatmap_pil.size   # PIL: (width, height)

        _log(f"Heatmap: {img_w}×{img_h} px  Grid: {grid_cols}×{grid_rows}")
        _log(f"ROI (image-px): x={roi_x} y={roi_y} w={roi_w} h={roi_h}")

        # ── Clamp ROI to the computational data rectangle ─────────────────────
        # The Stage 1 PNG includes presentation-only title/axes/margins and a
        # colorbar. Only the axes rectangle maps to the FDFD grid.
        data_rect = s1.get("heatmapDataRect")
        if not isinstance(data_rect, dict):
            raise ValueError(
                "This Stage 1 run does not contain computational heatmap geometry. "
                "Re-run Stage 1 before confirming an ROI."
            )

        try:
            data_x = float(data_rect["x"])
            data_y = float(data_rect["y"])
            data_w = float(data_rect["width"])
            data_h = float(data_rect["height"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Stage 1 computational heatmap geometry is invalid") from exc

        if data_w <= 0 or data_h <= 0:
            raise ValueError("Stage 1 computational heatmap geometry is empty")

        data_x2 = min(img_w, data_x + data_w)
        data_y2 = min(img_h, data_y + data_h)
        if data_x >= data_x2 or data_y >= data_y2:
            raise ValueError("Stage 1 computational heatmap geometry is outside the image")

        selection_x2 = roi_x + roi_w
        selection_y2 = roi_y + roi_h
        roi_x = max(roi_x, int(np.ceil(data_x)))
        roi_y = max(roi_y, int(np.ceil(data_y)))
        roi_x2 = min(selection_x2, int(np.floor(data_x2)))
        roi_y2 = min(selection_y2, int(np.floor(data_y2)))
        if roi_x >= roi_x2 or roi_y >= roi_y2:
            raise ValueError(
                "The selected ROI is outside the computational heatmap area. "
                "Select a region inside the colored data field."
            )

        roi_w  = roi_x2 - roi_x
        roi_h  = roi_y2 - roi_y

        # ── Map computational image coords → grid coords ──────────────────────
        sx = data_w / grid_cols  # pixels per grid column
        sy = data_h / grid_rows  # pixels per grid row

        x0_g = int(round((roi_x  - data_x) / sx))
        y0_g = int(round((roi_y  - data_y) / sy))
        x1_g = int(round((roi_x2 - data_x) / sx))
        y1_g = int(round((roi_y2 - data_y) / sy))

        x0_g = max(0, min(x0_g, grid_cols))
        y0_g = max(0, min(y0_g, grid_rows))
        x1_g = max(x0_g + 1, min(x1_g, grid_cols))
        y1_g = max(y0_g + 1, min(y1_g, grid_rows))

        crop_cols = x1_g - x0_g
        crop_rows = y1_g - y0_g

        _log(f"Grid crop: cols [{x0_g}:{x1_g}]  rows [{y0_g}:{y1_g}]  "
             f"→ {crop_cols}×{crop_rows} cells")

        # ── Crop numpy arrays ─────────────────────────────────────────────────
        mag_db   = np.load(os.path.join(stage1_dir, "mag_db.npy"))
        map_mask = np.load(os.path.join(stage1_dir, "map_mask.npy"))
        occupancy_path = os.path.join(stage1_dir, "map_occupancy.npy")
        map_occupancy = (np.load(occupancy_path) if os.path.exists(occupancy_path)
                         else map_mask.astype(float))

        roi_mag_db   = mag_db[y0_g:y1_g, x0_g:x1_g].copy()
        roi_map_mask = map_mask[y0_g:y1_g, x0_g:x1_g].copy()
        roi_map_occupancy = map_occupancy[y0_g:y1_g, x0_g:x1_g].copy()

        np.save(os.path.join(stage1_dir, "roi_mag_db.npy"),   roi_mag_db)
        np.save(os.path.join(stage1_dir, "roi_map_mask.npy"), roi_map_mask)
        np.save(os.path.join(stage1_dir, "roi_map_occupancy.npy"), roi_map_occupancy)
        _log(f"✓ roi_mag_db.npy   shape={roi_mag_db.shape}")
        _log(f"✓ roi_map_mask.npy shape={roi_map_mask.shape}")

        # ── Crop heatmap image ────────────────────────────────────────────────
        roi_heatmap = heatmap_pil.convert("RGB").crop((roi_x, roi_y, roi_x2, roi_y2))
        roi_heatmap.save(os.path.join(stage1_dir, "roi_heatmap.png"))
        _log(f"✓ roi_heatmap.png  {roi_heatmap.width}×{roi_heatmap.height} px")

        # ── Crop campus map ───────────────────────────────────────────────────
        campus_path = os.path.join(stage1_dir, "campus_map.png")
        if os.path.exists(campus_path):
            campus_pil = Image.open(campus_path).convert("RGB")
            camp_w, camp_h = campus_pil.size
            # campus_map is sized to (grid_cols, grid_rows) — map proportionally
            cx0 = int(round(x0_g * camp_w / grid_cols))
            cy0 = int(round(y0_g * camp_h / grid_rows))
            cx1 = int(round(x1_g * camp_w / grid_cols))
            cy1 = int(round(y1_g * camp_h / grid_rows))
            cx1 = max(cx0 + 1, min(cx1, camp_w))
            cy1 = max(cy0 + 1, min(cy1, camp_h))
            roi_campus = campus_pil.crop((cx0, cy0, cx1, cy1))
            roi_campus.save(os.path.join(stage1_dir, "roi_campus_map.png"))
            _log(f"✓ roi_campus_map.png  {roi_campus.width}×{roi_campus.height} px")
        else:
            _log("⚠ campus_map.png not found — skipping roi_campus_map.png")

        # ── Transmitter coords in cropped-grid domain ─────────────────────────
        src_x_c = int(max(0, min(src_x - x0_g, crop_cols - 1)))
        src_y_c = int(max(0, min(src_y - y0_g, crop_rows - 1)))

        # ── Write roi.json ────────────────────────────────────────────────────
        roi_data = {
            # Image-space ROI (returned to the client)
            "x":      roi_x,
            "y":      roi_y,
            "width":  roi_w,
            "height": roi_h,
            # Grid-space crop bounds (used by run_stage2.py)
            "x0Grid":         x0_g,
            "y0Grid":         y0_g,
            "x1Grid":         x1_g,
            "y1Grid":         y1_g,
            "croppedGridCols": crop_cols,
            "croppedGridRows": crop_rows,
            # Adjusted transmitter position in cropped domain
            "srcXCropped": src_x_c,
            "srcYCropped": src_y_c,
        }
        with open(os.path.join(stage1_dir, "roi.json"), "w") as f:
            json.dump(roi_data, f, indent=2)
        _log("✓ roi.json written")

        print(json.dumps({"ok": True, "roi": roi_data}))
        sys.exit(0)

    except SystemExit:
        raise
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
