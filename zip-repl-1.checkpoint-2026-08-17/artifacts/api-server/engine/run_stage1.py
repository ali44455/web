"""
CLI entry point invoked by the Node API server as a subprocess. Runs the
Stage 1 FDFD simulation in one of two modes:

  stage0 mode (preferred):
    python3 run_stage1.py stage0 <stage0_mask.npy> <stage0_processed_map.png> <params_json> <output_dir>
    Consumes a Stage 0 run's canonical mask + processed map directly. The
    mask is never re-derived from pixel colors.

  raw mode (Workflow A — "Simulation Ready Map", direct upload):
    python3 run_stage1.py raw <image_path> <params_json> <output_dir>
    The caller (the user, via the frontend) has explicitly chosen this
    workflow because their map is already in the simulator's native
    two-tone floor-plan format. No automatic format detection or rejection
    happens here — that choice belongs to the user, not the backend.

Both modes write:
  - a rendered heatmap PNG
  - a metadata JSON (grid size, peak dB, source position, resolved params)
  - the raw mag_db grid and the building mask as .npy files (for future
    Stage 2 dead-zone detection to reuse without recomputation)

On success: exits 0, writes <output_dir>/result.json.
On failure: exits 1, writes a JSON error to stderr.
"""

import json
import os
import sys
import traceback

# Node captures this process through pipes on Windows.  Do not let the active
# console code page make a harmless progress symbol terminate the simulation.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

_threads = os.environ.get("FDFD_NUM_THREADS", str(max(1, os.cpu_count() or 1)))
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_name, _threads)
import numpy as np
from PIL import Image

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from stage1_engine import SingleAntennaSim, build_params


def _log(msg):
    """Print a timestamped progress line to stdout so the Node service can
    capture the exact step at which a failure occurred."""
    print(f"[stage1] {msg}", flush=True)


def _write_outputs(output_dir, sim, params, result, source_mode, execution_time_ms):
    _log("Writing heatmap.png …")
    with open(f"{output_dir}/heatmap.png", "wb") as f:
        f.write(result["png_bytes"])

    _log("Writing mag_db.npy …")
    np.save(f"{output_dir}/mag_db.npy", result["mag_db"])

    _log("Writing map_mask.npy …")
    np.save(f"{output_dir}/map_mask.npy", sim.map_mask)

    _log("Writing map_occupancy.npy …")
    np.save(f"{output_dir}/map_occupancy.npy", sim.map_occupancy)

    # Save the clean campus map at GRID resolution (rows x cols), with NO
    # matplotlib decorations (no colorbar, no title, no margins).  Stage 2
    # loads this as its working image so that computational coordinates and
    # display coordinates are identical — the entire image IS the ROI.
    _log("Writing campus_map.png …")
    bg_pil = Image.fromarray(sim.background_image)
    # PIL resize: (width=cols, height=rows)
    bg_small = bg_pil.resize(
        (params["cols"], params["rows"]), Image.LANCZOS
    )
    bg_small.save(f"{output_dir}/campus_map.png")

    metadata = {
        "gridRows": params["rows"],
        "gridCols": params["cols"],
        "executionTimeMs": execution_time_ms,
        "peakDb": result["real_peak_db"],
        "sourceX": result["src_x"],
        "sourceY": result["src_y"],
        "wasSourceSnapped": result["was_source_snapped"],
        "occupiedFraction": result["occupied_fraction"],
        "heatmapDataRect": result["heatmap_data_rect"],
        "sourceMode": source_mode,
        "resolvedParams": {
            "cellSizeMeters": params["h"],
            "frequencyMHz": params["f_sim"] / 1e6,
            "refractiveIndex": params["n_eff"],
            "absorptionCoeff": params["alpha_eff"],
            "sourceValue": params["source_val"],
            "minDb": params["min_db"],
            "pmlWidth": params["pml_width"],
            "pmlMaxLoss": params["pml_max_loss"],
            "alpha3dBump": params["alpha_3d_bump"],
            "sourceXPercent": params["source_x_percent"],
            "sourceYPercent": params["source_y_percent"],
            "cellBudget": params["cell_budget"],
        },
    }

    _log("Writing result.json …")
    with open(f"{output_dir}/result.json", "w") as f:
        json.dump(metadata, f)

    _log(f"✓ All outputs written — peak={result['real_peak_db']:.1f} dB  "
         f"grid={params['rows']}×{params['cols']}  "
         f"elapsed={execution_time_ms:.0f} ms")


def run_stage0_mode(mask_path, processed_map_path, params_json_path, output_dir):
    import time

    _log("Mode: stage0")
    _log(f"Reading params from {params_json_path} …")
    with open(params_json_path, "r") as f:
        form = json.load(f)
    _log(f"✓ Params parsed: {list(form.keys())}")

    _log(f"Loading canonical mask from {mask_path} …")
    canonical_mask = np.load(mask_path)
    _log(f"✓ Mask loaded: shape={canonical_mask.shape} dtype={canonical_mask.dtype}")

    _log(f"Loading processed map from {processed_map_path} …")
    processed_map = np.array(Image.open(processed_map_path).convert("RGB"))
    _log(f"✓ Processed map loaded: shape={processed_map.shape}")

    _log("Building physics params …")
    params = build_params(canonical_mask.shape, form)
    _log(f"✓ Grid: {params['rows']}×{params['cols']}  h={params['h']} m  "
         f"f={params['f_sim']/1e6:g} MHz")

    _log("Constructing simulator …")
    start = time.perf_counter()
    sim = SingleAntennaSim(processed_map, params, background_image=processed_map)

    _log("Applying canonical mask …")
    _log("Starting FDFD solve …")
    result = sim.run_with_canonical_mask(canonical_mask)
    execution_time_ms = (time.perf_counter() - start) * 1000.0
    _log(f"✓ Simulation complete in {execution_time_ms:.0f} ms")

    _write_outputs(output_dir, sim, params, result, "stage0", execution_time_ms)


def run_raw_mode(image_path, params_json_path, output_dir):
    import time

    _log("Mode: raw")
    _log(f"Reading params from {params_json_path} …")
    with open(params_json_path, "r") as f:
        form = json.load(f)
    _log(f"✓ Params parsed: {list(form.keys())}")

    _log(f"Loading image from {image_path} …")
    pil_img = Image.open(image_path).convert("RGB")
    raw_image = np.array(pil_img)
    _log(f"✓ Image loaded: shape={raw_image.shape}  format={pil_img.format}")

    _log("Building physics params …")
    params = build_params(raw_image.shape, form)
    _log(f"✓ Grid: {params['rows']}×{params['cols']}  h={params['h']} m  "
         f"f={params['f_sim']/1e6:g} MHz")

    _log("Constructing simulator …")
    start = time.perf_counter()
    sim = SingleAntennaSim(raw_image, params)

    _log("Processing map (Otsu threshold + mask cleanup) …")
    _log("Placing source / snapping to open cell …")
    _log("Starting FDFD solve …")
    result = sim.run()
    execution_time_ms = (time.perf_counter() - start) * 1000.0
    _log(f"✓ Simulation complete in {execution_time_ms:.0f} ms")

    _write_outputs(output_dir, sim, params, result, "raw", execution_time_ms)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: run_stage1.py <stage0|raw> ..."}), file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]

    try:
        if mode == "stage0":
            if len(sys.argv) != 6:
                raise ValueError("usage: run_stage1.py stage0 <mask.npy> <processed_map.png> <params_json> <output_dir>")
            run_stage0_mode(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        elif mode == "raw":
            if len(sys.argv) != 5:
                raise ValueError("usage: run_stage1.py raw <image> <params_json> <output_dir>")
            run_raw_mode(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            raise ValueError(f"unknown mode: {mode}")

        print(json.dumps({"ok": True}))
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - report any failure back to the caller
        # Write the full traceback to stderr so the Node service can surface it,
        # then write a final JSON line so it can also extract a short message.
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
