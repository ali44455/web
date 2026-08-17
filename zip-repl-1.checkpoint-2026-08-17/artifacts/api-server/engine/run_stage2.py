"""
CLI entry point for Stage 2 — Node Placement & Optimization.

PIPELINE ARCHITECTURE
---------------------
ROI cropping happens at Stage 1 — the user confirms the ROI on the Stage 1
page, which calls crop_stage1_roi.py to pre-crop ALL outputs and write them
into the Stage 1 run directory:

  <stage1_run_dir>/roi.json            — confirmed ROI + grid bounds
  <stage1_run_dir>/roi_mag_db.npy      — cropped signal matrix
  <stage1_run_dir>/roi_map_mask.npy    — cropped binary mask
  <stage1_run_dir>/roi_heatmap.png     — cropped heatmap (no colorbar)
  <stage1_run_dir>/roi_campus_map.png  — cropped campus image

Stage 2 reads these pre-cropped files exclusively.  It never sees the full
Stage 1 heatmap or the raw arrays.  If roi.json is missing, Stage 2 aborts
with a clear error so the frontend can direct the user back to Stage 1.

Usage:
  python3 run_stage2.py <stage1_run_dir> <output_dir>

On success: exits 0, prints {"ok":true} to stdout, writes to <output_dir>/:
  result.json, visualization.png, cropped_heatmap.png, nodes.npy,
  centroids.npy, stage2_data.npz

On failure: exits 1, JSON {"error":"..."} on stderr.
"""

import json
import os
import sys
import time
import traceback

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from PIL import Image

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from node_placer_optimizer import NodePlacerOptimizer

NODE_COVERAGE_RADIUS = 50   # grid cells — optimization value, never changed


def _log(msg):
    print(f"[stage2] {msg}", flush=True)


# ─── Visualization ────────────────────────────────────────────────────────────

def render_visualization(heatmap_png_path, result, grid_rows, grid_cols, output_path):
    """
    Render Stage 2 node-placement overlay on the pre-cropped heatmap.

    The background image contains only the signal-data region — no colorbar,
    no margins.  Figure sizing is driven by the image aspect ratio so that
    coverage circles appear proportional to the display area (MATLAB-like).

    Overlay elements
    ----------------
    • Blue circles     : candidate-phase nodes (before optimization)
    • Orange squares   : final optimized nodes
    • Orange circles   : coverage radius for each final node
    • Orange X marks   : cluster centroids
    • Red star         : transmitter (TX)
    • Bottom text box  : stats
    """
    heatmap_pil = Image.open(heatmap_png_path).convert("RGB")
    heatmap_arr = np.array(heatmap_pil)
    img_h, img_w = heatmap_arr.shape[:2]

    # ── Dynamic figure size — match the image aspect ratio ──────────────────
    aspect = img_w / img_h
    fig_w  = min(14.0, max(6.0, 10.0 * aspect))
    fig_h  = fig_w / aspect
    fig_h  = min(fig_h, 12.0)
    fig_w  = fig_h * aspect

    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=120)
    ax.imshow(heatmap_arr, aspect='auto', extent=[0, img_w, img_h, 0])
    ax.set_xlim(0, img_w)
    ax.set_ylim(img_h, 0)
    ax.set_axis_off()

    # ── Scale factors: grid cells → image pixels ─────────────────────────────
    sx = img_w / grid_cols
    sy = img_h / grid_rows

    def gx(x): return float(x) * sx
    def gy(y): return float(y) * sy

    # Coverage radius in image pixels
    r_img   = NODE_COVERAGE_RADIUS * (sx + sy) / 2
    sq_pt   = max(7,  min(18, int(r_img / 12)))
    star_pt = max(14, min(28, int(r_img / 8)))

    # ── Extract optimizer result arrays ──────────────────────────────────────
    final_nodes  = np.array(result['finalNodes'])       if len(result['finalNodes'])       > 0 else np.zeros((0, 2))
    nodes_before = np.array(result['nodesBeforeOpt'])   if len(result['nodesBeforeOpt'])   > 0 else np.zeros((0, 2))
    centroids    = np.array(result['clusterCentroids']) if len(result['clusterCentroids']) > 0 else np.zeros((0, 2))
    tx, ty       = float(result['transmitter'][0]), float(result['transmitter'][1])
    cov_frac     = float(result['coverageFraction'])

    # ── Before-optimization nodes (blue circles, no fill) ────────────────────
    for node in nodes_before:
        circle = mpatches.Circle(
            (gx(node[0]), gy(node[1])), r_img,
            fill=False, edgecolor='#4488FF', linewidth=1.2, alpha=0.45,
        )
        ax.add_patch(circle)
        ax.plot(gx(node[0]), gy(node[1]), 'o',
                color='#4488FF', markersize=sq_pt * 0.5, alpha=0.5,
                markeredgecolor='none')

    # ── Final optimized nodes (orange squares + coverage circles) ─────────────
    orange = '#FF8C00'
    for i, node in enumerate(final_nodes):
        nx_img, ny_img = gx(node[0]), gy(node[1])

        circle = mpatches.Circle(
            (nx_img, ny_img), r_img,
            fill=False, edgecolor=orange, linewidth=1.8, alpha=0.90,
        )
        ax.add_patch(circle)

        ax.plot(nx_img, ny_img, 's',
                color=orange, markerfacecolor=orange, markersize=sq_pt,
                markeredgecolor='black', markeredgewidth=0.8, zorder=5)

        ax.text(nx_img + r_img * 0.15, ny_img, str(i + 1),
                color='yellow', fontsize=max(6, sq_pt * 0.7),
                fontweight='bold', va='center', zorder=6)

    # ── Cluster centroids (orange X marks, faint) ─────────────────────────────
    for cc in centroids:
        ax.plot(gx(cc[0]), gy(cc[1]), 'x',
                color='#FF6600', markersize=sq_pt * 0.6,
                markeredgewidth=1.0, alpha=0.65, zorder=4)

    # ── Transmitter (red star) ────────────────────────────────────────────────
    ax.plot(gx(tx), gy(ty), 'r*',
            markersize=star_pt, markeredgewidth=0.8,
            markeredgecolor='white', zorder=7)

    # ── Legend ───────────────────────────────────────────────────────────────
    legend_handles = [
        mpatches.Patch(facecolor='#4488FF', alpha=0.5, label='Before optimization'),
        mpatches.Patch(facecolor=orange,   label=f'Final nodes ({len(final_nodes)})'),
        plt.Line2D([0], [0], marker='*', color='w', markerfacecolor='red',
                   markersize=10, label=f'TX [{int(tx)}, {int(ty)}]'),
    ]
    ax.legend(handles=legend_handles, loc='upper right',
              facecolor='black', edgecolor='white', labelcolor='white',
              fontsize=7)

    # ── Stats box ─────────────────────────────────────────────────────────────
    stats = (
        f"Coverage: {cov_frac * 100:.1f}%  |  "
        f"Nodes: {len(final_nodes)}  |  "
        f"Clusters: {len(centroids)}  |  "
        f"Radius: {NODE_COVERAGE_RADIUS} cells"
    )
    ax.text(0.01, 0.02, stats, transform=ax.transAxes,
            color='white', fontsize=7, va='bottom',
            bbox=dict(facecolor='black', alpha=0.6, boxstyle='round,pad=0.3'),
            zorder=8)

    ax.set_title(
        f"Stage 2: Node Placement & Optimization  |  "
        f"{len(final_nodes)} Final Nodes  |  Coverage: {cov_frac * 100:.1f}%",
        color='white', fontsize=10, pad=4,
        bbox=dict(facecolor='#111111', alpha=0.7),
    )

    plt.tight_layout(pad=0.1)
    fig.savefig(output_path, dpi=120, bbox_inches='tight',
                facecolor='black', edgecolor='none')
    plt.close(fig)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 3:
        print(
            json.dumps({"error": "Usage: run_stage2.py <stage1_run_dir> <output_dir>"}),
            file=sys.stderr,
        )
        sys.exit(1)

    stage1_dir = sys.argv[1]
    output_dir = sys.argv[2]

    try:
        # ── Require a confirmed ROI ────────────────────────────────────────────
        roi_json_path = os.path.join(stage1_dir, "roi.json")
        if not os.path.exists(roi_json_path):
            raise FileNotFoundError(
                "No confirmed ROI found for this Stage 1 run. "
                "Please go back to Stage 1, draw an ROI on the heatmap, "
                "and click 'Confirm ROI' before proceeding to Stage 2."
            )

        with open(roi_json_path) as f:
            roi_data = json.load(f)

        grid_cols = int(roi_data["croppedGridCols"])
        grid_rows = int(roi_data["croppedGridRows"])
        src_x     = int(roi_data["srcXCropped"])
        src_y     = int(roi_data["srcYCropped"])

        _log(f"ROI confirmed — cropped grid={grid_cols}×{grid_rows}  src=({src_x},{src_y})")

        # ── Load pre-cropped Stage 1 outputs ──────────────────────────────────
        _log(f"Loading pre-cropped Stage 1 outputs from {stage1_dir} …")

        mag_db_path   = os.path.join(stage1_dir, "roi_mag_db.npy")
        map_mask_path = os.path.join(stage1_dir, "roi_map_mask.npy")
        heatmap_path  = os.path.join(stage1_dir, "roi_heatmap.png")

        for p in (mag_db_path, map_mask_path, heatmap_path):
            if not os.path.exists(p):
                raise FileNotFoundError(
                    f"Pre-cropped file missing: {p}. "
                    "Please re-confirm the ROI on the Stage 1 page."
                )

        mag_db   = np.load(mag_db_path)
        map_mask = np.load(map_mask_path)
        _log(f"✓ roi_mag_db shape={mag_db.shape}  roi_map_mask shape={map_mask.shape}")

        # Campus map — cropped version if available, else synthesize
        campus_png = os.path.join(stage1_dir, "roi_campus_map.png")
        if os.path.exists(campus_png):
            campus_pil = Image.open(campus_png).convert("RGB")
            if campus_pil.width != grid_cols or campus_pil.height != grid_rows:
                campus_pil = campus_pil.resize((grid_cols, grid_rows), Image.LANCZOS)
            campus_img = np.array(campus_pil)
        else:
            _log("⚠ roi_campus_map.png not found — synthesising from roi_map_mask")
            gray = np.where(map_mask, 55, 210).astype(np.uint8)
            campus_img = np.stack([gray, gray, gray], axis=-1)
        _log(f"✓ Campus image: {campus_img.shape[1]}×{campus_img.shape[0]}")

        # Copy cropped heatmap to output dir (Stage 3 reads from here)
        import shutil
        cropped_heatmap_path = os.path.join(output_dir, "cropped_heatmap.png")
        shutil.copy2(heatmap_path, cropped_heatmap_path)
        _log("✓ cropped_heatmap.png written to output dir")

        # ── Run NodePlacerOptimizer on the cropped domain ─────────────────────
        _log("Initialising NodePlacerOptimizer …")
        npo = NodePlacerOptimizer()
        npo.NodeCoverageRadius = NODE_COVERAGE_RADIUS
        _log(
            f"Dead-zone threshold: {npo.DeadZoneThreshold_dBm:.2f} dBm "
            "(MATLAB default)"
        )

        stage1_out = {
            'mag_db': mag_db,
            'src_x':  src_x,
            'src_y':  src_y,
        }

        _log(f"Running optimizer (grid={grid_rows}×{grid_cols}) …")
        t0         = time.perf_counter()
        result     = npo.run(campus_img, stage1_out, map_mask)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        _log(f"✓ Optimizer complete in {elapsed_ms:.0f} ms")

        final_nodes = result['finalNodes']
        centroids   = result['clusterCentroids']
        candidates  = result['candidateLocations']
        cov_frac    = float(result['coverageFraction'])

        _log(
            f"  nodes={len(final_nodes)}  clusters={len(centroids)}  "
            f"coverage={cov_frac * 100:.1f}%"
        )

        # ── Render visualization ──────────────────────────────────────────────
        _log("Rendering visualization on cropped heatmap …")
        vis_path = os.path.join(output_dir, "visualization.png")
        render_visualization(
            cropped_heatmap_path,
            result,
            grid_rows,
            grid_cols,
            vis_path,
        )
        _log("✓ visualization.png written")

        # ── Save numpy arrays for Stage 3 ─────────────────────────────────────
        final_nodes_arr = np.array(final_nodes) if len(final_nodes) > 0 else np.zeros((0, 2))
        centroids_arr   = np.array(centroids)   if len(centroids)   > 0 else np.zeros((0, 2))

        np.save(os.path.join(output_dir, "nodes.npy"),     final_nodes_arr)
        np.save(os.path.join(output_dir, "centroids.npy"), centroids_arr)

        np.savez(
            os.path.join(output_dir, "stage2_data.npz"),
            final_nodes           = final_nodes_arr,
            cluster_centroids     = centroids_arr,
            transmitter           = result['transmitter'],
            node_coverage_radius  = np.array([float(NODE_COVERAGE_RADIUS)]),
            dead_zone_mask        = result['deadZoneMask'],
            best_r                = np.array([float(result['bestR'])]),
            coverage_fraction     = np.array([cov_frac]),
            radius_sweep          = np.asarray(result.get('radiusSweep', []), dtype=float),
            crop_grid_cols        = np.array([grid_cols]),
            crop_grid_rows        = np.array([grid_rows]),
        )
        _log("✓ stage2_data.npz written")

        # ── Write result.json ─────────────────────────────────────────────────
        metadata = {
            "executionTimeMs":     elapsed_ms,
            "finalNodes":          final_nodes_arr.tolist(),
            "candidateLocations":  (candidates.tolist()
                                    if len(candidates) > 0 else []),
            "clusterCentroids":    centroids_arr.tolist(),
            "coveragePercent":     round(cov_frac * 100, 2),
            "nodeCount":           len(final_nodes_arr),
            "numClusters":         len(centroids_arr),
            "bestExclusionRadius": float(result['bestR']),
            "nodeCoverageRadius":  float(NODE_COVERAGE_RADIUS),
            "deadZoneThresholdDbm": float(npo.DeadZoneThreshold_dBm),
            # Retained for the existing API contract. MATLAB does not use a
            # percentile-derived threshold, so this is explicitly disabled.
            "deadZonePercentile": 0,
            "transmitter":         [float(result['transmitter'][0]),
                                    float(result['transmitter'][1])],
            "imageWidth":          grid_cols,
            "imageHeight":         grid_rows,
            "radiusSweep":         result.get('radiusSweep', []),
        }
        with open(os.path.join(output_dir, "result.json"), "w") as f:
            json.dump(metadata, f)
        _log(
            f"✓ result.json  nodes={len(final_nodes_arr)}  "
            f"coverage={cov_frac * 100:.1f}%  domain={grid_cols}×{grid_rows}"
        )

        print(json.dumps({"ok": True}))
        sys.exit(0)

    except SystemExit:
        raise
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
