#!/usr/bin/env python3
"""
Stage 4 — Phased Array Beam Steering Simulation.

Reads from Stage 1 run dir  : roi_map_mask.npy, roi_heatmap.png (or roi_campus_map.png)
Reads from Stage 2 result   : finalNodes, transmitter (pixel coords in ROI space)
Streams JSON lines to stdout: progress events + base64-encoded frame PNGs
Writes to output dir        : result.json, max_hold.png

Usage:
  python3 run_stage4.py <stage1RunDir> <stage2RunDir> <outputDir> <paramsJsonPath>
"""

import sys
import os
import json
import math
import io
import time
import base64

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# Let NumPy/SciPy/OpenCV use the available CPU by default. Replit or a laptop
# can override this with FDFD_NUM_THREADS when sharing the machine.
_fdfd_threads = os.environ.get("FDFD_NUM_THREADS", str(max(1, os.cpu_count() or 1)))
for _thread_var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_thread_var, _fdfd_threads)
import numpy as np
import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patheffects as pe
from matplotlib.patches import Wedge
from scipy.sparse import spdiags, eye, kron
from scipy.sparse.linalg import splu
from PIL import Image

try:
    cv2.setNumThreads(int(_fdfd_threads))
except (TypeError, ValueError):
    pass

def _emit(obj):
    """Flush a JSON line to stdout for SSE consumption."""
    print(json.dumps(obj), flush=True)

def _fig_to_b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor())
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


def _save_frame_png(output_dir, frame_idx, image_base64):
    """Persist every rendered frame so completed runs can be replayed/exported."""
    frames_dir = os.path.join(output_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    with open(os.path.join(frames_dir, f"frame-{frame_idx:05d}.png"), "wb") as f_out:
        f_out.write(base64.b64decode(image_base64))


def _compile_video(output_dir, fps=2):
    """Create a browser-downloadable MP4 from the rendered PNG frames."""
    frames_dir = os.path.join(output_dir, "frames")
    frame_paths = [
        os.path.join(frames_dir, name)
        for name in sorted(os.listdir(frames_dir))
        if name.endswith(".png")
    ] if os.path.isdir(frames_dir) else []
    if not frame_paths:
        return None

    first = cv2.imread(frame_paths[0])
    if first is None:
        return None
    height, width = first.shape[:2]
    video_path = os.path.join(output_dir, "phased-array-simulation.mp4")
    writer = cv2.VideoWriter(
        video_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        float(fps),
        (width, height),
    )
    if not writer.isOpened():
        return None
    try:
        for frame_path in frame_paths:
            frame = cv2.imread(frame_path)
            if frame is None:
                continue
            if frame.shape[1] != width or frame.shape[0] != height:
                frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            writer.write(frame)
    finally:
        writer.release()
    return os.path.basename(video_path) if os.path.exists(video_path) else None

# ─── Coordinate helpers ───────────────────────────────────────────────────────

def meters_to_pixel(x_m, y_m, h, hy):
    col = int(round(x_m / h))
    row = int(round(y_m / hy))
    return row, col

def pixel_to_meters(row, col, h, hy):
    return col * h, row * hy

def shortest_angular_path(theta_from, theta_to):
    diff = (theta_to - theta_from) % 360
    if diff > 180:
        return -1, 360 - diff
    return 1, diff

# ─── PhasedArraySim (from notebook, physics untouched) ───────────────────────

class PhasedArraySim:
    """
    5-element phased array Helmholtz simulator (FDM, 2D).
    Identical physics to the reference notebook — only I/O adapted for subprocess use.
    """

    def __init__(self, raw_image, binary_mask, real_width, real_height,
                 occupancy=None,
                 tx_power_dbm=19,
                 antenna_x=None,
                 antenna_y=None,
                 f_sim=50e6,
                 alpha_air=0.00002,
                 alpha_eff=0.062,
                 step_angle=0.1,
                 n_eff=2.0, pml_width=20, pml_max_loss=0.5,
                 alpha_3d_bump=0.0):

        self.img_raw    = np.array(raw_image)
        self.map_mask   = binary_mask
        self.map_occupancy = (np.asarray(occupancy, dtype=float)
                              if occupancy is not None else binary_mask.astype(float))
        self.params     = self._get_hyperparameters(
            binary_mask, real_width, real_height,
            tx_power_dbm, antenna_x, antenna_y,
            f_sim, alpha_air, alpha_eff, step_angle,
            n_eff, pml_width, pml_max_loss, alpha_3d_bump
        )
        self.img_cropped = None
        self.src_x       = None
        self.src_y       = None
        self._solve      = None
        self._lu         = None
        self.sectors_array = []
        self.angle_cache   = {}
        self.result_matrix = None
        self.batch_size = 1

    def _get_hyperparameters(self, binary_mask, real_width, real_height,
                              tx_power_dbm, antenna_x, antenna_y,
                              f_sim, alpha_air, alpha_eff, step_angle,
                              n_eff, pml_width, pml_max_loss, alpha_3d_bump):
        p = {}
        p["rows"], p["cols"] = binary_mask.shape
        p["real_width"]  = real_width
        p["real_height"] = real_height
        p["h"]           = real_width / p["cols"]
        p["f_sim"]   = f_sim
        p["c"]       = 3e8
        p["lambda"]  = p["c"] / p["f_sim"]
        p["k0"]      = 2 * np.pi * p["f_sim"] / p["c"]
        p["alpha_air"] = alpha_air
        p["n_eff"]     = n_eff
        p["alpha_eff"] = alpha_eff
        p["pml_width"] = int(pml_width)
        p["pml_max_loss"] = float(pml_max_loss)
        p["alpha_3d_bump"] = float(alpha_3d_bump)
        p["num_elements"] = 5
        p["d"]            = p["lambda"] / 2
        p["step_angle"] = step_angle
        if antenna_x is None:
            antenna_x = real_width  * 0.05
        if antenna_y is None:
            antenna_y = real_height * 0.05
        p["antenna_x_m"] = antenna_x
        p["antenna_y_m"] = antenna_y
        p["user_tx_power_dbm"] = tx_power_dbm
        p["array_gain_db"]     = 20 * np.log10(p["num_elements"])
        base_0db_amp           = 1000 / (10 ** (29.6 / 20))
        p["source_amp"]        = base_0db_amp * (10 ** (tx_power_dbm / 20))
        p["keep_width_ratio"]  = 1.0
        return p

    def process_map(self):
        valid_cols        = round(self.params["cols"] * self.params["keep_width_ratio"])
        self.img_cropped  = self.img_raw[:, :valid_cols, :]
        self.map_mask     = self.map_mask[:, :valid_cols]
        self.map_occupancy = self.map_occupancy[:, :valid_cols]
        self.params["cols"] = valid_cols
        return self

    def place_sources(self):
        h_x = self.params["real_width"]  / self.params["cols"]
        h_y = self.params["real_height"] / self.params["rows"]
        start_x = round(self.params["antenna_x_m"] / h_x)
        start_y = round(self.params["antenna_y_m"] / h_y)
        pixel_spacing = max(1, round(self.params["d"] / h_x))
        self.src_x = np.zeros(self.params["num_elements"], dtype=int)
        self.src_y = np.zeros(self.params["num_elements"], dtype=int)
        for n in range(self.params["num_elements"]):
            self.src_x[n] = start_x + n * pixel_spacing
            self.src_y[n] = start_y
        return self

    def phase_shifter(self, theta_deg):
        theta_rad    = np.deg2rad(theta_deg)
        n            = np.arange(self.params["num_elements"])
        phase_shifts = -n * self.params["k0"] * self.params["d"] * np.sin(theta_rad)
        return self.params["source_amp"] * np.exp(1j * phase_shifts)

    def _build_system_matrix(self):
        rows = self.params["rows"]
        cols = self.params["cols"]
        N    = rows * cols
        h    = self.params["h"]
        e    = np.ones(N)
        D2_r = spdiags([e, -2*e, e], [-1, 0, 1], rows, rows) / (h**2)
        D2_c = spdiags([e, -2*e, e], [-1, 0, 1], cols, cols) / (h**2)
        Laplacian = kron(eye(cols), D2_r) + kron(D2_c, eye(rows))
        k_air      = self.params["k0"] - 1j * self.params["alpha_air"]
        k_building = self.params["k0"] * self.params["n_eff"] - 1j * self.params["alpha_eff"]
        occupancy_flat = self.map_occupancy.flatten(order="F")
        k_vec = (1.0 - occupancy_flat) * k_air + occupancy_flat * k_building
        if self.params["alpha_3d_bump"] > 0:
            k_vec = k_vec - 1j * self.params["alpha_3d_bump"]
        pml_width = self.params["pml_width"]
        if pml_width > 0 and self.params["pml_max_loss"] > 0:
            row_idx = np.arange(rows).reshape(-1, 1)
            col_idx = np.arange(cols).reshape(1, -1)
            dist_to_edge = np.minimum.reduce([
                np.broadcast_to(row_idx, (rows, cols)),
                np.broadcast_to((rows - 1) - row_idx, (rows, cols)),
                np.broadcast_to(col_idx, (rows, cols)),
                np.broadcast_to((cols - 1) - col_idx, (rows, cols)),
            ]).astype(float)
            ramp = np.clip((pml_width - dist_to_edge) / pml_width, 0.0, 1.0) ** 2
            k_vec = k_vec - 1j * (self.params["pml_max_loss"] * ramp).flatten(order="F")
        A = Laplacian + spdiags(k_vec**2, 0, N, N)
        # Keep the reusable SuperLU object so multiple phase-shifter right-hand
        # sides can be solved in one call. This is substantially faster than
        # invoking a Python-level solve once per angle.
        self._lu = splu(A.tocsc(), permc_spec="COLAMD")
        self._solve = self._lu.solve
        return self._solve

    def solve_for_angle(self, theta_deg):
        if self._solve is None:
            self._build_system_matrix()
        rows = self.params["rows"]
        cols = self.params["cols"]
        N    = rows * cols
        src_indices = self.src_y + self.src_x * rows
        b = np.zeros(N, dtype=complex)
        b[src_indices] = self.phase_shifter(theta_deg)
        E_vec = self._solve(-b)
        E     = E_vec.reshape((rows, cols), order="F")
        return 20 * np.log10(np.abs(E) + 1e-12)

    def precompute_all_angles(self, progress_cb=None):
        if self._solve is None:
            self._build_system_matrix()
        step = float(self.params["step_angle"])
        # Integer indexing avoids floating-point drift (e.g. 359.90000001)
        # while allowing the 0.1-degree / 3,600-frame scan requested by the UI.
        angle_count = max(1, int(round(360.0 / step)))
        self.sectors_array = []
        self.angle_cache   = {}
        self.result_matrix = None
        retain_matrices = step >= 1.0
        src_indices = self.src_y + self.src_x * self.params["rows"]
        # A moderate batch uses all available numerical-library throughput
        # without creating a multi-GB RHS. Override for a particular laptop.
        default_batch = min(32, max(4, (os.cpu_count() or 4) * 2))
        batch_size = max(1, int(os.environ.get("FDFD_BATCH_SIZE", default_batch)))
        self.batch_size = batch_size
        for start in range(0, angle_count, batch_size):
            batch_angles = [round(i * step, 6)
                            for i in range(start, min(start + batch_size, angle_count))]
            rhs = np.zeros((self.params["rows"] * self.params["cols"],
                            len(batch_angles)), dtype=complex)
            rhs[src_indices, :] = np.column_stack(
                [self.phase_shifter(theta) for theta in batch_angles])
            fields = self._lu.solve(-rhs)
            for offset, theta in enumerate(batch_angles):
                E = fields[:, offset].reshape(
                    (self.params["rows"], self.params["cols"]), order="F")
                mag_db = 20 * np.log10(np.abs(E) + 1e-12)
                # Keeping 3,600 grids of a 200k-cell ROI would consume several
                # GB. Fine scans retain only max-hold and solve target angles
                # on demand using the same LU factor.
                if retain_matrices:
                    self.sectors_array.append({"angle": theta, "matrix_db": mag_db})
                    self.angle_cache[theta] = mag_db
                if self.result_matrix is None:
                    self.result_matrix = mag_db.copy()
                else:
                    np.maximum(self.result_matrix, mag_db, out=self.result_matrix)
                if progress_cb:
                    progress_cb(start + offset + 1, angle_count, theta, mag_db)
        return self

    def get_cached_angle(self, theta_deg):
        step = float(self.params["step_angle"])
        rounded = round((round(theta_deg / step) * step) % 360.0, 6)
        if rounded not in self.angle_cache:
            self.angle_cache[rounded] = self.solve_for_angle(rounded)
        return rounded, self.angle_cache[rounded]

    def max_hold_coverage(self):
        if self.result_matrix is None and self.sectors_array:
            self.result_matrix = np.max(
                np.stack([s["matrix_db"] for s in self.sectors_array], axis=2), axis=2)
        return self.result_matrix

    def run_simulation(self, progress_cb=None):
        self.process_map()
        self.place_sources()
        self._build_system_matrix()
        self.precompute_all_angles(progress_cb)
        return self

# ─── Frame drawing helpers ────────────────────────────────────────────────────

FRAME_FIGSIZE   = (10, 8)
FRAME_DPI       = 90
FRAME_FACECOLOR = "#1e1e2e"


def _draw_common_frame(mag_db, W, H, vmin=None, vmax=None):
    if vmin is None:
        vmin = np.min(mag_db)
    if vmax is None:
        vmax = max(15, np.max(mag_db))
    fig, ax = plt.subplots(figsize=FRAME_FIGSIZE, dpi=FRAME_DPI,
                            facecolor=FRAME_FACECOLOR)
    ax.set_facecolor(FRAME_FACECOLOR)
    im = ax.imshow(mag_db, cmap="jet", extent=[0, W, H, 0], vmin=vmin, vmax=vmax)
    cb = fig.colorbar(im, ax=ax, fraction=0.04, pad=0.03)
    cb.set_label("Signal (dB)", color="#cdd6f4")
    plt.setp(cb.ax.yaxis.get_ticklabels(), color="#cdd6f4")
    ax.tick_params(colors="#cdd6f4")
    for sp in ax.spines.values():
        sp.set_edgecolor("#45475a")
    return fig, ax


def _text_box(ax, text):
    ax.text(0.02, 0.98, text, transform=ax.transAxes, va="top", ha="left",
            fontsize=9, family="monospace", color="#cdd6f4",
            bbox=dict(facecolor="#1e1e2e", alpha=0.85, pad=5,
                      boxstyle="round,pad=0.4"))


def _rc_to_m(row, col, h, hy):
    return col * h, row * hy


def draw_node_placement_frame(mask, all_nodes, weak_node_ids, src_row, src_col,
                               W, H, h, hy):
    fig, ax = plt.subplots(figsize=FRAME_FIGSIZE, dpi=FRAME_DPI,
                            facecolor=FRAME_FACECOLOR)
    ax.set_facecolor(FRAME_FACECOLOR)
    backdrop = np.where(mask == 1, 0.3, 0.05)
    ax.imshow(backdrop, cmap="gray", extent=[0, W, H, 0], vmin=0, vmax=1)
    for n in all_nodes:
        nr, nc = n["_solver_rc"]
        nx_m, ny_m = _rc_to_m(nr, nc, h, hy)
        color = "orange" if n["id"] in weak_node_ids else "red"
        ax.scatter(nx_m, ny_m, s=120, c=color, edgecolors="white",
                   linewidths=1.2, zorder=5)
        ax.text(nx_m + 0.015 * W, ny_m, f"#{n['id']:02d}", color="white",
                fontsize=8, zorder=6, va="center",
                path_effects=[pe.withStroke(linewidth=2, foreground="black")])
    ax_m, ay_m = _rc_to_m(src_row, src_col, h, hy)
    ax.scatter(ax_m, ay_m, s=400, marker="*", c="magenta",
               edgecolors="white", linewidths=1.2, zorder=8)
    ax.set_xlim(0, W); ax.set_ylim(H, 0)
    ax.tick_params(colors="#cdd6f4")
    for sp in ax.spines.values():
        sp.set_edgecolor("#45475a")
    ax.scatter([], [], s=120, c="red",    edgecolors="white", label="Node (OK)")
    ax.scatter([], [], s=120, c="orange", edgecolors="white", label="Node (weak → will target)")
    ax.scatter([], [], s=400, marker="*", c="magenta", edgecolors="white", label="Phased Array")
    leg = ax.legend(loc="lower right", facecolor="#1e1e2e", labelcolor="#cdd6f4",
                    framealpha=0.85, fontsize=8)
    _text_box(ax, f"NODE PLACEMENT — {len(all_nodes)} node(s)\n"
                   f"{len(weak_node_ids)} below RSSI threshold (will be targeted)\n"
                   f"→ Phased array installed at ★ — beam steering begins")
    plt.tight_layout()
    b64 = _fig_to_b64(fig)
    plt.close(fig)
    return b64


def draw_baseline_frame(rssi_grid, all_nodes, weakest_node,
                         src_row, src_col, W, H, h, hy,
                         dbm_min=-100, dbm_max=-30):
    fig, ax = _draw_common_frame(rssi_grid, W, H, vmin=dbm_min, vmax=dbm_max)
    for n in all_nodes:
        nr, nc = n["_solver_rc"]
        nx_m, ny_m = _rc_to_m(nr, nc, h, hy)
        ax.scatter(nx_m, ny_m, s=80, c="red", edgecolors="white",
                   linewidths=1.0, zorder=5)
    ax_m, ay_m = _rc_to_m(src_row, src_col, h, hy)
    if weakest_node is not None:
        wr, wc = weakest_node["_solver_rc"]
        wx_m, wy_m = _rc_to_m(wr, wc, h, hy)
        ax.scatter(wx_m, wy_m, s=400, c="yellow", alpha=0.3, zorder=4)
        ax.scatter(wx_m, wy_m, s=200, c="yellow", edgecolors="white",
                   linewidths=1.5, zorder=6)
        ax.annotate("", xy=(wx_m, wy_m), xytext=(ax_m, ay_m),
                    arrowprops=dict(arrowstyle="->", color="cyan", lw=2), zorder=7)
        _text_box(ax, f"BASELINE — Single Antenna\n"
                       f"First target: #{weakest_node['id']:02d} | "
                       f"RSSI: {weakest_node['baseline_rssi']:.1f} dBm\n"
                       f"→ Replacing with phased array")
    else:
        _text_box(ax, "BASELINE — Single Antenna\nNo weak spots found.")
    ax.scatter(ax_m, ay_m, s=400, marker="*", c="magenta",
               edgecolors="white", linewidths=1.2, zorder=8)
    plt.tight_layout()
    b64 = _fig_to_b64(fig)
    plt.close(fig)
    return b64


def draw_steering_frame(mag_db, theta_current, theta_target, target, all_nodes,
                         unreachable_ids, iteration, n_iterations,
                         antenna_m, W, H):
    fig, ax = _draw_common_frame(mag_db, W, H)
    for n in all_nodes:
        nx_m, ny_m = n["_m"]
        if n["id"] in unreachable_ids:
            ax.scatter(nx_m, ny_m, s=80, c="grey", edgecolors="white",
                       linewidths=1.0, zorder=5)
        elif n["id"] == target["id"]:
            ax.scatter(nx_m, ny_m, s=220, c="yellow", edgecolors="white",
                       linewidths=1.5, zorder=6)
        else:
            ax.scatter(nx_m, ny_m, s=80, c="red", edgecolors="white",
                       linewidths=1.0, zorder=5)
    wedge = Wedge(antenna_m, 0.15 * min(W, H), theta_current - 25,
                  theta_current + 25, facecolor="#00ffff", alpha=0.12, zorder=3)
    ax.add_patch(wedge)
    ax.scatter(*antenna_m, s=400, marker="*", c="magenta",
               edgecolors="white", linewidths=1.2, zorder=8)
    beam_len = 0.1 * min(W, H)
    dx = beam_len * math.cos(math.radians(theta_current))
    dy = -beam_len * math.sin(math.radians(theta_current))
    ax.annotate("", xy=(antenna_m[0]+dx, antenna_m[1]+dy), xytext=antenna_m,
                arrowprops=dict(arrowstyle="->", color="white", lw=2), zorder=8)
    _text_box(ax, f"Iteration: {iteration:02d} / {n_iterations}\n"
                   f"Beam: {theta_current:03.0f}° → Target #{target['id']:02d}\n"
                   f"Baseline: {target['baseline_rssi']:.1f} dBm | "
                   f"Delivered: {target.get('current_rssi', target['baseline_rssi']):.1f} dBm")
    plt.tight_layout()
    b64 = _fig_to_b64(fig)
    plt.close(fig)
    return b64


def draw_scan_frame(mag_db, theta_current, all_nodes, antenna_m, W, H,
                    target_node_id=None):
    """Render one frame of the scientific full-azimuth scan.

    The field is the cached FDFD solution for this exact phase-shifter angle;
    the cyan wedge shows the electronically steered main lobe and the yellow
    marker identifies the node nearest the current beam direction.
    """
    fig, ax = _draw_common_frame(mag_db, W, H)
    for n in all_nodes:
        nx_m, ny_m = n["_m"]
        nr, nc = n["_solver_rc"]
        val = float(mag_db[nr, nc])
        if target_node_id is not None and n["id"] == target_node_id:
            ax.scatter(nx_m, ny_m, s=220, c="yellow", edgecolors="white",
                       linewidths=1.5, zorder=7)
            ax.annotate(f"NODE #{n['id']:02d}  {val:.1f} dB", (nx_m, ny_m),
                        textcoords="offset points", xytext=(0, 10),
                        ha="center", fontsize=7, color="white", zorder=9,
                        path_effects=[pe.withStroke(linewidth=2, foreground="black")])
        else:
            ax.scatter(nx_m, ny_m, s=80, c="red", edgecolors="white",
                       linewidths=1.0, zorder=5)
    wedge = Wedge(antenna_m, 0.18 * min(W, H), theta_current - 18,
                  theta_current + 18, facecolor="#00ffff", alpha=0.18,
                  edgecolor="#00ffff", linewidth=1.0, zorder=3)
    ax.add_patch(wedge)
    ax.scatter(*antenna_m, s=400, marker="*", c="magenta",
               edgecolors="white", linewidths=1.2, zorder=8)
    beam_len = 0.42 * min(W, H)
    dx = beam_len * math.cos(math.radians(theta_current))
    dy = -beam_len * math.sin(math.radians(theta_current))
    ax.annotate("", xy=(antenna_m[0] + dx, antenna_m[1] + dy),
                xytext=antenna_m,
                arrowprops=dict(arrowstyle="->", color="white", lw=2),
                zorder=8)
    _text_box(ax, f"FULL 360 DEGREE SCAN\n"
                   f"Beam angle: {theta_current:03.0f} deg\n"
                   f"FDFD field cached with sparse LU factorization\n"
                   f"Yellow marker: node currently illuminated")
    plt.tight_layout()
    b64 = _fig_to_b64(fig)
    plt.close(fig)
    return b64


def draw_scan_frame_fast(mag_db, theta_current, all_nodes, antenna_m, W, H,
                         target_node_id=None, vmin=-100.0, vmax=15.0):
    """Fast OpenCV renderer for high-rate scan video.

    Matplotlib is ideal for the setup/final scientific plots, but creating a
    new figure for each of 3,600 frames is unnecessarily slow. This renderer
    preserves the field, beam wedge, antenna, and node annotations while using
    a single raster pipeline suitable for smooth MP4 generation.
    """
    out_w, out_h = 900, 720
    plot_x, plot_y, plot_w, plot_h = 58, 18, 780, 650
    field = np.nan_to_num(mag_db, nan=vmin, posinf=vmax, neginf=vmin)
    clipped = np.clip((field - vmin) / max(vmax - vmin, 1.0), 0.0, 1.0)
    gray = (clipped * 255.0).astype(np.uint8)
    color = cv2.applyColorMap(gray, cv2.COLORMAP_JET)
    color = cv2.resize(color, (plot_w, plot_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((out_h, out_w, 3), (30, 30, 46), dtype=np.uint8)
    canvas[plot_y:plot_y + plot_h, plot_x:plot_x + plot_w] = color

    def to_px(x_m, y_m):
        return (plot_x + int(np.clip(x_m / max(W, 1e-9), 0, 1) * (plot_w - 1)),
                plot_y + int(np.clip(y_m / max(H, 1e-9), 0, 1) * (plot_h - 1)))

    ant_px = to_px(*antenna_m)
    radius = max(55, int(0.18 * min(plot_w, plot_h)))
    start = math.radians(theta_current - 18)
    end = math.radians(theta_current + 18)
    arc = []
    for t in np.linspace(start, end, 18):
        arc.append((ant_px[0] + int(radius * math.cos(t)),
                    ant_px[1] - int(radius * math.sin(t))))
    poly = np.array([ant_px, *arc], dtype=np.int32)
    overlay = canvas.copy()
    cv2.fillPoly(overlay, [poly], (255, 255, 0))
    cv2.addWeighted(overlay, 0.15, canvas, 0.85, 0, canvas)
    beam_len = int(0.42 * min(plot_w, plot_h))
    beam_end = (ant_px[0] + int(beam_len * math.cos(math.radians(theta_current))),
                ant_px[1] - int(beam_len * math.sin(math.radians(theta_current))))
    cv2.arrowedLine(canvas, ant_px, beam_end, (255, 255, 255), 2, tipLength=0.04)

    for node in all_nodes:
        nx_m, ny_m = node["_m"]
        node_px = to_px(nx_m, ny_m)
        is_target = target_node_id is not None and node["id"] == target_node_id
        cv2.circle(canvas, node_px, 8 if is_target else 5,
                   (0, 255, 255) if is_target else (40, 40, 230), -1)
        cv2.circle(canvas, node_px, 8 if is_target else 5, (255, 255, 255), 1)
        if is_target:
            cv2.putText(canvas, f"NODE #{node['id']:02d}",
                        (node_px[0] + 10, node_px[1] - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1,
                        cv2.LINE_AA)
    cv2.drawMarker(canvas, ant_px, (255, 0, 255), cv2.MARKER_STAR, 26, 2)
    cv2.putText(canvas, "FULL 360 DEGREE FDFD SCAN", (18, 685),
                cv2.FONT_HERSHEY_DUPLEX, 0.62, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(canvas, f"BEAM {theta_current:06.1f} deg  |  5-element ULA  |  d=lambda/2",
                (18, 708), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (220, 220, 220), 1,
                cv2.LINE_AA)
    ok, encoded = cv2.imencode(".png", canvas, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:
        raise RuntimeError("OpenCV could not encode scan frame")
    return base64.b64encode(encoded.tobytes()).decode()


def draw_final_labeled_frame(mag_db, theta_current, all_nodes,
                              unreachable_ids, antenna_m, W, H):
    fig, ax = _draw_common_frame(mag_db, W, H)
    for n in all_nodes:
        nx_m, ny_m = n["_m"]
        nr, nc = n["_solver_rc"]
        val = mag_db[nr, nc]
        color = "grey" if n["id"] in unreachable_ids else "red"
        ax.scatter(nx_m, ny_m, s=80, c=color, edgecolors="white",
                   linewidths=1.0, zorder=5)
        ax.annotate(f"{val:.1f}", (nx_m, ny_m),
                    textcoords="offset points", xytext=(0, 8),
                    ha="center", fontsize=7, color="white", zorder=9,
                    path_effects=[pe.withStroke(linewidth=2, foreground="black")])
    wedge = Wedge(antenna_m, 0.15 * min(W, H), theta_current - 25,
                  theta_current + 25, facecolor="#00ffff", alpha=0.12, zorder=3)
    ax.add_patch(wedge)
    ax.scatter(*antenna_m, s=400, marker="*", c="magenta",
               edgecolors="white", linewidths=1.2, zorder=8)
    _text_box(ax, f"FINAL BEAM — {theta_current:03.0f}°\n"
                   f"dB delivered per node at this angle\n"
                   f"{len(unreachable_ids)} grey/unreachable")
    plt.tight_layout()
    b64 = _fig_to_b64(fig)
    plt.close(fig)
    return b64


def draw_max_hold_frame(max_hold_db, all_nodes, unreachable_ids, antenna_m, W, H):
    fig, ax = _draw_common_frame(max_hold_db, W, H)
    for n in all_nodes:
        nx_m, ny_m = n["_m"]
        color = "grey" if n["id"] in unreachable_ids else "red"
        ax.scatter(nx_m, ny_m, s=80, c=color, edgecolors="white",
                   linewidths=1.0, zorder=5)
    ax.scatter(*antenna_m, s=400, marker="*", c="magenta",
               edgecolors="white", linewidths=1.2, zorder=8)
    _text_box(ax, f"MAX-HOLD COVERAGE — full 360° sweep\n"
                   f"Best signal per pixel across all beam angles\n"
                   f"{len(all_nodes)} node(s) total, {len(unreachable_ids)} grey/unreachable")
    plt.tight_layout()
    b64 = _fig_to_b64(fig)
    plt.close(fig)
    return b64


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    t_start = time.time()

    if len(sys.argv) != 5:
        print(json.dumps({"error": "Usage: run_stage4.py <stage1RunDir> <stage2RunDir> <outputDir> <paramsJson>"}),
              file=sys.stderr, flush=True)
        sys.exit(1)

    stage1_run_dir = sys.argv[1]
    stage2_run_dir = sys.argv[2]
    output_dir     = sys.argv[3]
    params_path    = sys.argv[4]

    os.makedirs(output_dir, exist_ok=True)

    # Load params
    with open(params_path) as f:
        params = json.load(f)

    real_width           = float(params["realWidth"])
    real_height          = float(params["realHeight"])
    freq_hz              = float(params["freqHz"])
    tx_power_dbm         = float(params.get("txPowerDbm", 19.0))
    alpha_air            = float(params.get("alphaAir", 0.00002))
    alpha_eff            = float(params.get("alphaEff", 0.062))
    n_eff                = float(params.get("refractiveIndex", 2.0))
    pml_width            = int(params.get("pmlWidth", 20))
    pml_max_loss         = float(params.get("pmlMaxLoss", 0.5))
    alpha_3d_bump        = float(params.get("alpha3dBump", 0.0))
    target_rssi          = float(params.get("targetRssiThreshold", -80.0))
    n_iterations         = int(params.get("nIterations", 10))
    # A 0.1-degree default produces 3,600 electronically steered positions.
    # The factorized FDFD matrix is reused for every phase-shifter solve.
    step_angle           = min(3.0, max(0.1, float(params.get("stepAngle", 0.1))))
    antenna_x_m          = float(params["antennaXMeters"])
    antenna_y_m          = float(params["antennaYMeters"])
    final_nodes_px       = params["finalNodes"]   # [[x, y], ...]

    # Load ROI mask
    mask_path = os.path.join(stage1_run_dir, "roi_map_mask.npy")
    if not os.path.exists(mask_path):
        _emit({"type": "error", "message": "roi_map_mask.npy not found in stage1RunDir — ROI must be confirmed first"})
        sys.exit(1)

    binary_mask = np.load(mask_path)   # shape (rows, cols), 1=building
    occupancy_path = os.path.join(stage1_run_dir, "roi_map_occupancy.npy")
    occupancy = (np.load(occupancy_path) if os.path.exists(occupancy_path)
                 else binary_mask.astype(float))
    rows, cols  = binary_mask.shape
    h  = real_width  / cols
    hy = real_height / rows

    # Load campus map image for frame backgrounds
    map_img_path = os.path.join(stage1_run_dir, "roi_campus_map.png")
    if not os.path.exists(map_img_path):
        map_img_path = os.path.join(stage1_run_dir, "roi_heatmap.png")
    if os.path.exists(map_img_path):
        raw_image = Image.open(map_img_path).convert("RGB").resize(
            (cols, rows), Image.LANCZOS)
    else:
        # Fallback: blank dark image
        raw_image = Image.fromarray(
            (np.ones((rows, cols, 3)) * 20).astype(np.uint8))

    # Transmitter pixel → clip to grid
    ant_col = int(np.clip(round(antenna_x_m / h),  0, cols - 1))
    ant_row = int(np.clip(round(antenna_y_m / hy), 0, rows - 1))
    src_row, src_col = ant_row, ant_col

    # Build node list in solver space
    all_nodes = []
    for idx, (nx, ny) in enumerate(final_nodes_px):
        col_n = int(np.clip(round(float(nx)), 0, cols - 1))
        row_n = int(np.clip(round(float(ny)), 0, rows - 1))
        # Derive baseline RSSI from node pixel (approximate — not the true dBm
        # but we use it to rank nodes)
        all_nodes.append({
            "id": idx,
            "_solver_rc": (row_n, col_n),
        })

    # Compute baseline RSSI for each node using a cheap free-space estimate
    # (actual FDFD baseline would require re-running stage1 — we approximate)
    # Use the stage1 mag_db if it exists (roi_mag_db.npy)
    mag_db_stage1 = None
    roi_mag_path = os.path.join(stage1_run_dir, "roi_mag_db.npy")
    if os.path.exists(roi_mag_path):
        mag_db_stage1 = np.load(roi_mag_path)

    for n in all_nodes:
        r, c = n["_solver_rc"]
        if mag_db_stage1 is not None and mag_db_stage1.shape == binary_mask.shape:
            n["baseline_rssi"] = float(mag_db_stage1[r, c])
        else:
            # Very rough free-space approximation
            dist_m = math.sqrt(((c - src_col) * h) ** 2 + ((r - src_row) * hy) ** 2)
            dist_m = max(dist_m, 0.5)
            n["baseline_rssi"] = -20 * math.log10(dist_m) - 40
        n["current_rssi"] = n["baseline_rssi"]
        n["_m"] = _rc_to_m(r, c, h, hy)

    antenna_m = _rc_to_m(src_row, src_col, h, hy)

    # Nodes below target_rssi are the ones we steer toward
    weak_node_ids = {n["id"] for n in all_nodes if n["baseline_rssi"] < target_rssi}
    weak_nodes    = [n for n in all_nodes if n["id"] in weak_node_ids]

    total_angles = max(1, int(round(360.0 / step_angle)))
    _emit({
        "type": "init",
        "nodeCount": len(all_nodes),
        "weakNodeCount": len(weak_nodes),
        "totalAngles": total_angles,
        "nIterations": n_iterations,
    })

    frame_idx = 0
    unreachable_ids = set()

    # ── Frame 0: node placement ──────────────────────────────────────────────
    b64 = draw_node_placement_frame(
        binary_mask, all_nodes, weak_node_ids,
        src_row, src_col, real_width, real_height, h, hy)
    _save_frame_png(output_dir, frame_idx, b64)
    _emit({"type": "frame", "frameIdx": frame_idx, "frameType": "node_placement",
           "imageBase64": b64,
           "metadata": {"nodeCount": len(all_nodes), "weakCount": len(weak_nodes)}})
    frame_idx += 1

    # ── Phased array setup ────────────────────────────────────────────────────
    # Render the single-antenna reference before the moving-beam frames.
    if mag_db_stage1 is not None and mag_db_stage1.shape == binary_mask.shape:
        first_target = (min(weak_nodes, key=lambda n: n["current_rssi"])
                        if weak_nodes else None)
        b64 = draw_baseline_frame(
            mag_db_stage1, all_nodes, first_target,
            src_row, src_col, real_width, real_height, h, hy)
        _save_frame_png(output_dir, frame_idx, b64)
        _emit({"type": "frame", "frameIdx": frame_idx, "frameType": "baseline",
               "imageBase64": b64,
               "metadata": {"description": "Single-antenna baseline RSSI"}})
        frame_idx += 1

    _emit({"type": "precompute_start", "totalAngles": total_angles})

    phased = PhasedArraySim(
        raw_image=raw_image, binary_mask=binary_mask, occupancy=occupancy,
        real_width=real_width, real_height=real_height,
        tx_power_dbm=tx_power_dbm,
        antenna_x=antenna_x_m, antenna_y=antenna_y_m,
        f_sim=freq_hz, alpha_air=alpha_air, alpha_eff=alpha_eff,
        step_angle=step_angle, n_eff=n_eff, pml_width=pml_width,
        pml_max_loss=pml_max_loss, alpha_3d_bump=alpha_3d_bump)

    scan_nodes = all_nodes
    # Persist every frame for the MP4, but send a bounded live preview over
    # SSE. At 0.1° this is about 300 preview images instead of hundreds of MB
    # of duplicate base64 traffic; the downloaded video still contains 3,600.
    scan_emit_stride = max(1, int(math.ceil(total_angles / 360.0)))
    analysis_targets = (15.0, 40.0, 60.0, 75.0)
    analysis_sectors = {}

    def on_precompute(done, total, angle, mag_db):
        """Rasterize each field immediately, avoiding a multi-GB angle cache."""
        nonlocal frame_idx
        for target_angle in analysis_targets:
            if target_angle not in analysis_sectors:
                angular_distance = abs(
                    (float(angle) - target_angle + 180.0) % 360.0 - 180.0
                )
                if angular_distance <= step_angle / 2.0 + 1e-7:
                    analysis_sectors[target_angle] = mag_db.copy()
        _emit({"type": "precompute_progress", "done": done, "total": total,
               "angle": angle})
        target_id = None
        if scan_nodes:
            def angular_error(node):
                nx_m, ny_m = node["_m"]
                desired = math.degrees(math.atan2(-(ny_m - antenna_m[1]),
                                                  nx_m - antenna_m[0])) % 360
                return abs((desired - angle + 180) % 360 - 180)
            target_id = min(scan_nodes, key=angular_error)["id"]
        b64 = draw_scan_frame_fast(
            mag_db, float(angle), all_nodes, antenna_m,
            real_width, real_height, target_id)
        _save_frame_png(output_dir, frame_idx, b64)
        if done == 1 or done == total or done % scan_emit_stride == 0:
            _emit({"type": "frame", "frameIdx": frame_idx, "frameType": "scan",
                   "imageBase64": b64,
                   "metadata": {"angle": float(angle), "scanIndex": done - 1,
                                "scanTotal": total, "targetNodeId": target_id,
                                "description": "Full 360-degree phased-array scan"}})
        frame_idx += 1

    phased.run_simulation(progress_cb=on_precompute)

    _emit({"type": "precompute_done", "elapsedMs": int((time.time() - t_start) * 1000)})

    # ── Frame 1: baseline ─────────────────────────────────────────────────────
    if False and mag_db_stage1 is not None and mag_db_stage1.shape == binary_mask.shape:
        first_target = (min(weak_nodes, key=lambda n: n["current_rssi"])
                        if weak_nodes else None)
        b64 = draw_baseline_frame(
            mag_db_stage1, all_nodes, first_target,
            src_row, src_col, real_width, real_height, h, hy)
        _save_frame_png(output_dir, frame_idx, b64)
        _emit({"type": "frame", "frameIdx": frame_idx, "frameType": "baseline",
               "imageBase64": b64,
               "metadata": {"description": "Single-antenna baseline RSSI"}})
        frame_idx += 1

    # Full-region scan: stream every cached beam angle, even when no node is
    # below the RSSI threshold. This is the visible antenna animation and is
    # deliberately separate from the optional weak-node targeting loop.
    scan_nodes = all_nodes
    # Scan frames were emitted directly by on_precompute; this legacy replay
    # loop remains empty so no field is rendered or stored a second time.
    for scan_idx, sector in enumerate(()):
        theta_scan = float(sector["angle"])
        target_id = None
        if scan_nodes:
            def angular_error(node):
                nx_m, ny_m = node["_m"]
                desired = math.degrees(math.atan2(-(ny_m - antenna_m[1]),
                                                  nx_m - antenna_m[0])) % 360
                return abs((desired - theta_scan + 180) % 360 - 180)
            target_id = min(scan_nodes, key=angular_error)["id"]
        b64 = draw_scan_frame(
            sector["matrix_db"], theta_scan, all_nodes, antenna_m,
            real_width, real_height, target_id)
        _save_frame_png(output_dir, frame_idx, b64)
        _emit({
            "type": "frame", "frameIdx": frame_idx, "frameType": "scan",
            "imageBase64": b64,
            "metadata": {
                "angle": theta_scan,
                "scanIndex": scan_idx,
                "scanTotal": len(phased.sectors_array),
                "targetNodeId": target_id,
                "description": "Full 360-degree phased-array scan",
            },
        })
        frame_idx += 1

    # ── Steering loop ─────────────────────────────────────────────────────────
    if not weak_nodes:
        _emit({"type": "info",
               "message": f"No nodes below {target_rssi} dBm — nothing to steer toward"})
    else:
        theta_current  = 0.0
        for iteration in range(1, n_iterations + 1):
            searchable = [n for n in weak_nodes if n["id"] not in unreachable_ids]
            if not searchable:
                _emit({"type": "info",
                       "message": f"All weak nodes unreachable — stopping at iteration {iteration - 1}"})
                break

            target = min(searchable, key=lambda n: n["current_rssi"])
            tx_m_node, ty_m_node = target["_m"]

            dx_beam = tx_m_node - antenna_m[0]
            dy_beam = -(ty_m_node - antenna_m[1])
            theta_target_raw = math.degrees(math.atan2(dy_beam, dx_beam)) % 360
            theta_target, mag_db = phased.get_cached_angle(theta_target_raw)
            theta_current = theta_target

            b64 = draw_steering_frame(
                mag_db, theta_current, theta_target, target, all_nodes,
                unreachable_ids, iteration, n_iterations, antenna_m,
                real_width, real_height)
            _save_frame_png(output_dir, frame_idx, b64)

            nr, nc = target["_solver_rc"]
            delivered = float(mag_db[nr, nc])
            target["current_rssi"] = delivered
            if delivered < target_rssi:
                unreachable_ids.add(target["id"])

            _emit({
                "type": "frame",
                "frameIdx": frame_idx,
                "frameType": "steering",
                "imageBase64": b64,
                "metadata": {
                    "iteration": iteration,
                    "totalIterations": n_iterations,
                    "angle": theta_current,
                    "targetNodeId": target["id"],
                    "baselineRssi": target["baseline_rssi"],
                    "deliveredRssi": delivered,
                    "unreachable": target["id"] in unreachable_ids,
                    "unreachableCount": len(unreachable_ids),
                }
            })
            frame_idx += 1

        # Final labeled frame
        _, final_mag_db = phased.get_cached_angle(theta_current)
        b64 = draw_final_labeled_frame(
            final_mag_db, theta_current, all_nodes,
            unreachable_ids, antenna_m, real_width, real_height)
        _save_frame_png(output_dir, frame_idx, b64)
        _emit({"type": "frame", "frameIdx": frame_idx, "frameType": "final_labeled",
               "imageBase64": b64,
               "metadata": {
                   "angle": theta_current,
                   "unreachableCount": len(unreachable_ids),
               }})
        frame_idx += 1

    # ── Max-hold frame ────────────────────────────────────────────────────────
    max_hold_db = phased.max_hold_coverage()
    np.save(os.path.join(output_dir, "max_hold_db.npy"), max_hold_db)
    if analysis_sectors:
        np.savez_compressed(
            os.path.join(output_dir, "analysis_sectors.npz"),
            **{f"angle_{angle:g}": grid
               for angle, grid in analysis_sectors.items()},
        )
    b64_max = draw_max_hold_frame(
        max_hold_db, all_nodes,
        unreachable_ids if weak_nodes else set(),
        antenna_m, real_width, real_height)
    _save_frame_png(output_dir, frame_idx, b64_max)

    # Save max_hold.png to output dir
    max_hold_path = os.path.join(output_dir, "max_hold.png")
    img_bytes = base64.b64decode(b64_max)
    with open(max_hold_path, "wb") as f_out:
        f_out.write(img_bytes)

    _emit({"type": "frame", "frameIdx": frame_idx, "frameType": "max_hold",
           "imageBase64": b64_max,
           "metadata": {
               "description": f"Best signal per pixel across all {total_angles} beam angles (360° sweep)"
           }})
    frame_idx += 1

    execution_ms = int((time.time() - t_start) * 1000)

    video_filename = _compile_video(output_dir, fps=30)

    node_results = []
    for node in all_nodes:
        nr, nc = node["_solver_rc"]
        node_results.append({
            "id": node["id"],
            "xMeters": node["_m"][0],
            "yMeters": node["_m"][1],
            "baselineRssiDbm": node["baseline_rssi"],
            "steeredRssiDbm": node["current_rssi"],
            "bestCoverageRssiDbm": float(max_hold_db[nr, nc]),
            "weak": node["id"] in weak_node_ids,
            "unreachable": node["id"] in unreachable_ids,
        })
    placement_score = (min(n["bestCoverageRssiDbm"] for n in node_results)
                       if node_results else None)

    result = {
        "executionTimeMs": execution_ms,
        "totalFrames": frame_idx,
        "nodeCount": len(all_nodes),
        "weakNodeCount": len(weak_nodes),
        "unreachableCount": len(unreachable_ids if weak_nodes else set()),
        "nIterations": n_iterations,
        "freqHz": freq_hz,
        "txPowerDbm": tx_power_dbm,
        "targetRssiThreshold": target_rssi,
        "stepAngle": step_angle,
        "antennaXMeters": antenna_x_m,
        "antennaYMeters": antenna_y_m,
        "antennaPlacement": {
            "xMeters": antenna_x_m,
            "yMeters": antenna_y_m,
            "xPercentOfRegion": (antenna_x_m / real_width * 100.0) if real_width else 0.0,
            "yPercentOfRegion": (antenna_y_m / real_height * 100.0) if real_height else 0.0,
            "xPixel": src_col,
            "yPixel": src_row,
            "method": "Selected transmitter position propagated from Heatmap Generation",
            "placementScoreDbm": placement_score,
        },
        "nodes": node_results,
        "maxHoldImageFilename": "max_hold.png",
        "analysisSectorAngles": sorted(analysis_sectors.keys()),
        "realWidth": real_width,
        "realHeight": real_height,
        "videoFilename": video_filename,
        "videoAvailable": video_filename is not None,
        "videoFps": 30,
        "resourceUsage": {
            "logicalCpuCores": int(os.cpu_count() or 1),
            "numericThreads": int(_fdfd_threads),
            "multiRhsBatchSize": int(phased.batch_size),
            "fullResolutionGridCells": int(rows * cols),
        },
    }
    with open(os.path.join(output_dir, "result.json"), "w") as f_out:
        json.dump(result, f_out)

    _emit({"type": "done", **result})


if __name__ == "__main__":
    main()
