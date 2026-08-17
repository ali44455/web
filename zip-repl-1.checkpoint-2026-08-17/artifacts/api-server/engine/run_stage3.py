"""
CLI entry point for Stage 3 — Budget-Constrained Node Selection.

Stage 3 NEVER recomputes Stage 1 or Stage 2.  It reads the already-optimised
node set, cluster centroids, and dead-zone mask from the Stage 2 run directory
and applies the MATLAB `runBudget` backward-elimination procedure.

Visualization background
-------------------------
Stage 3 always loads  <stage2_run_dir>/cropped_heatmap.png  as its background.
When Stage 2 was run with an ROI this file is the actual crop of the Stage 1
heatmap; when no ROI was used it is a copy of the full Stage 1 heatmap.
Either way node coordinates in stage2_data.npz are already relative to that
image, so no offset arithmetic is needed here.

Usage:
  python3 run_stage3.py <stage2_run_dir> <max_nodes> <stage1_run_dir> <output_dir>

On success: exits 0, writes to <output_dir>/:
  - result.json
  - visualization.png   (cropped heatmap + budget-selected nodes)

On failure: exits 1, JSON error on stderr.
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
from run_stage2 import NODE_COVERAGE_RADIUS, _log


def render_budget_visualization(heatmap_png_path, selected_nodes, all_nodes,
                                 transmitter, dead_zone_mask, best_r,
                                 coverage_fraction, max_nodes,
                                 grid_rows, grid_cols, output_path):
    """
    Render Stage 3 budget-selection overlay on the (already-cropped) heatmap.

    The background image is cropped_heatmap.png from the Stage 2 run directory —
    it contains only signal data (no colorbar, labels, or margins outside the ROI).

    Figure size is driven by the image's aspect ratio for MATLAB-like proportions.

    Shows:
      • All Stage-2 nodes in faint orange (context)
      • Budget-selected nodes as cyan squares + coverage circles
      • Transmitter as red star
    """
    heatmap_pil = Image.open(heatmap_png_path).convert("RGB")
    heatmap_arr = np.array(heatmap_pil)
    img_h, img_w = heatmap_arr.shape[:2]

    # ---- Dynamic figure size — match the cropped image aspect ratio ----
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

    # ---- Scale factors: grid cells → image pixels ----
    sx = img_w / grid_cols
    sy = img_h / grid_rows

    def gx(x): return float(x) * sx
    def gy(y): return float(y) * sy

    # Coverage radius in image pixels — proportional to displayed image
    r_img   = NODE_COVERAGE_RADIUS * (sx + sy) / 2
    sq_pt   = max(7,  min(18, int(r_img / 12)))
    star_pt = max(14, min(28, int(r_img / 8)))

    final_nodes  = np.array(selected_nodes) if len(selected_nodes) > 0 else np.zeros((0, 2))
    full_nodes   = np.array(all_nodes)      if len(all_nodes)      > 0 else np.zeros((0, 2))
    tx, ty       = float(transmitter[0]),   float(transmitter[1])

    # ---- All Stage-2 nodes (faint orange, for context) ----
    for node in full_nodes:
        ax.plot(gx(node[0]), gy(node[1]), 's',
                color='#FF8C00', markersize=sq_pt * 0.6, alpha=0.30,
                markeredgecolor='none')

    # ---- Budget-selected nodes (cyan squares + coverage circles) ----
    cyan = '#00D9FF'
    for i, node in enumerate(final_nodes):
        nx_img, ny_img = gx(node[0]), gy(node[1])

        circle = mpatches.Circle(
            (nx_img, ny_img), r_img,
            fill=False, edgecolor=cyan, linewidth=1.8, alpha=0.90,
        )
        ax.add_patch(circle)

        ax.plot(nx_img, ny_img, 's',
                color=cyan, markerfacecolor=cyan, markersize=sq_pt,
                markeredgecolor='black', markeredgewidth=0.8, zorder=5)

        ax.text(nx_img + r_img * 0.15, ny_img, str(i + 1),
                color=cyan, fontsize=max(6, sq_pt * 0.7),
                fontweight='bold', va='center', zorder=6)

    # ---- Transmitter (red star) ----
    ax.plot(gx(tx), gy(ty), 'r*',
            markersize=star_pt, markeredgewidth=0.8,
            markeredgecolor='white', zorder=7)

    # ---- Legend ----
    legend_handles = [
        mpatches.Patch(facecolor='#FF8C00', alpha=0.4,
                       label=f'All Stage-2 nodes ({len(full_nodes)})'),
        mpatches.Patch(facecolor=cyan,
                       label=f'Budget selected ({len(final_nodes)} / {max_nodes})'),
        plt.Line2D([0], [0], marker='*', color='w', markerfacecolor='red',
                   markersize=10, label=f'TX [{int(tx)}, {int(ty)}]'),
    ]
    ax.legend(handles=legend_handles, loc='upper right',
              facecolor='black', edgecolor='white', labelcolor='white',
              fontsize=7)

    # ---- Stats ----
    stats = (
        f"Budget coverage: {coverage_fraction * 100:.1f}%  |  "
        f"Selected: {len(final_nodes)} of {len(full_nodes)} nodes  |  "
        f"Budget limit: {max_nodes}"
    )
    ax.text(0.01, 0.02, stats, transform=ax.transAxes,
            color='white', fontsize=7, va='bottom',
            bbox=dict(facecolor='black', alpha=0.6, boxstyle='round,pad=0.3'),
            zorder=8)

    ax.set_title(
        f"Stage 3: Budget Optimization  |  "
        f"{len(final_nodes)} Nodes Selected  |  Coverage: {coverage_fraction * 100:.1f}%",
        color='white', fontsize=10, pad=4,
        bbox=dict(facecolor='#111111', alpha=0.7),
    )

    plt.tight_layout(pad=0.1)
    fig.savefig(output_path, dpi=120, bbox_inches='tight',
                facecolor='black', edgecolor='none')
    plt.close(fig)


def main():
    if len(sys.argv) != 5:
        print(
            json.dumps({"error":
                "usage: run_stage3.py <stage2_run_dir> <max_nodes> <stage1_run_dir> <output_dir>"}),
            file=sys.stderr,
        )
        sys.exit(1)

    stage2_dir = sys.argv[1]
    max_nodes  = int(sys.argv[2])
    stage1_dir = sys.argv[3]   # kept for API compatibility; never read
    output_dir = sys.argv[4]

    try:
        # ---- Load Stage 2 compact archive ----
        _log(f"Loading Stage 2 data from {stage2_dir} …")
        data = np.load(f"{stage2_dir}/stage2_data.npz", allow_pickle=False)

        # Always-present fields
        final_nodes   = data['final_nodes']           # N × 2
        cluster_cents = data['cluster_centroids']     # K × 2
        transmitter   = data['transmitter']            # [tx, ty]
        node_radius   = float(data['node_coverage_radius'][0])

        # Crop-domain grid dimensions (present in new-format npz)
        if 'crop_grid_cols' in data.files and 'crop_grid_rows' in data.files:
            crop_grid_cols = int(data['crop_grid_cols'][0])
            crop_grid_rows = int(data['crop_grid_rows'][0])
        else:
            crop_grid_cols = None
            crop_grid_rows = None

        # Dead-zone mask and coverage stats. These are mandatory Stage 2
        # artifacts: Stage 3 must never reconstruct them from Stage 1 data.
        npz_keys = list(data.files)
        if 'dead_zone_mask' in npz_keys and 'best_r' in npz_keys and 'coverage_fraction' in npz_keys:
            dead_zone_mask = data['dead_zone_mask'].astype(bool)
            best_r         = float(data['best_r'][0])
            stage2_cov     = float(data['coverage_fraction'][0])
            _log(f"✓ Loaded new-format stage2_data (dead_zone_mask present)")
        else:
            missing = [
                key for key in ('dead_zone_mask', 'best_r', 'coverage_fraction')
                if key not in npz_keys
            ]
            raise ValueError(
                "Stage 2 output is missing required cropped artifacts: "
                f"{', '.join(missing)}. Re-run Stage 2 after confirming the ROI."
            )

        _log(
            f"✓ Loaded: {len(final_nodes)} nodes, {len(cluster_cents)} clusters, "
            f"radius={node_radius}, best_r={best_r}"
        )

        # ---- Load Stage 2 result.json for grid/image dims ----
        with open(f"{stage2_dir}/result.json") as f:
            s2_meta = json.load(f)

        # Use crop-domain dimensions (from npz if available, else from result.json)
        if crop_grid_cols is not None:
            grid_w = crop_grid_cols
            grid_h = crop_grid_rows
        else:
            grid_w = int(s2_meta.get("imageWidth",  dead_zone_mask.shape[1]))
            grid_h = int(s2_meta.get("imageHeight", dead_zone_mask.shape[0]))

        # ---- Visualization background: use only Stage 2's cropped heatmap ----
        # This is the persisted ROI crop produced by Stage 2.
        # Either way, node coordinates in stage2_data.npz are relative to it.
        cropped_heatmap = f"{stage2_dir}/cropped_heatmap.png"
        if not os.path.exists(cropped_heatmap):
            raise FileNotFoundError(
                f"Required cropped Stage 2 heatmap is missing: {cropped_heatmap}. "
                "Re-run Stage 2 after confirming the ROI."
            )
        _log(f"✓ Using heatmap: {cropped_heatmap}")

        # ---- Budget selection ----
        _log(f"Running budget selection: max_nodes={max_nodes} …")

        npo = NodePlacerOptimizer()
        npo.NodeCoverageRadius = node_radius

        stage2_result = {
            'finalNodes':       final_nodes,
            'clusterCentroids': cluster_cents,
            'deadZoneMask':     dead_zone_mask,
            'transmitter':      transmitter,
            'bestR':            best_r,
            'coverageFraction': stage2_cov,
        }

        t0 = time.perf_counter()
        budget_result = npo.runBudget(stage2_result, max_nodes)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        _log(f"✓ Budget selection complete in {elapsed_ms:.0f} ms")

        selected_nodes = np.array(budget_result['finalNodes'])
        cov_frac       = float(budget_result['coverageFraction'])

        _log(
            f"  selected {len(selected_nodes)}/{len(final_nodes)} nodes  "
            f"coverage={cov_frac * 100:.1f}%"
        )

        # ---- Render visualization ----
        _log("Rendering visualization on cropped heatmap …")
        vis_path = f"{output_dir}/visualization.png"
        render_budget_visualization(
            cropped_heatmap,
            selected_nodes.tolist() if len(selected_nodes) > 0 else [],
            final_nodes.tolist()    if len(final_nodes)    > 0 else [],
            transmitter,
            dead_zone_mask,
            best_r,
            cov_frac,
            max_nodes,
            grid_h, grid_w,
            vis_path,
        )
        _log("✓ visualization.png written")

        # ---- Write result.json ----
        tx, ty = float(transmitter[0]), float(transmitter[1])
        metadata = {
            "executionTimeMs":  elapsed_ms,
            "finalNodes":       selected_nodes.tolist() if len(selected_nodes) > 0 else [],
            "coveragePercent":  round(cov_frac * 100, 2),
            "nodeCount":        len(selected_nodes),
            "maxNodes":         max_nodes,
            "transmitter":      [tx, ty],
            "clusterCentroids": cluster_cents.tolist() if len(cluster_cents) > 0 else [],
            "imageWidth":       grid_w,
            "imageHeight":      grid_h,
        }
        with open(f"{output_dir}/result.json", "w") as f:
            json.dump(metadata, f)
        _log(
            f"✓ result.json  nodes={len(selected_nodes)}  "
            f"coverage={cov_frac * 100:.1f}%"
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
