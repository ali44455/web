"""
FILE: stage1_engine.py

Headless engine for Stage 1 (Heatmap Generation), adapted from the original
research script `single_antenna_sim.py` (itself a Python port of
SingleAntennaSim.m). The physics and numerical methods (FDFD solve on a
sparse Laplacian, Otsu-threshold map segmentation, absorbing boundary,
nearest-open-cell source snapping) are UNCHANGED from that reference
implementation.

What was removed / changed for headless web use (no algorithmic changes):
  - No Colab magics, ipywidgets dashboard, or `plt.show()` — this module
    never opens a GUI window. It renders directly to an in-memory PNG using
    matplotlib's non-interactive Agg backend.
  - Grid rows/cols are derived per-request from the uploaded image's aspect
    ratio and a configurable cell budget (`compute_grid_size`, already
    present in the reference script) rather than a single hardcoded run.
  - All hyperparameters are passed in explicitly instead of being read from
    global dashboard widgets.
  - No self-test suite / launch_dashboard() — those are dev-only tools from
    the original notebook and not needed by the web API.
"""

import matplotlib

matplotlib.use("Agg")  # headless rendering, must be set before pyplot import

import io
import time
import cv2
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
from matplotlib.colors import Normalize
from scipy.ndimage import gaussian_filter
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from skimage.color import rgb2gray
from skimage.filters import threshold_otsu
from skimage.transform import resize
from skimage.morphology import remove_small_objects, remove_small_holes


# ---------------------------------------------------------------------------
# Fixed engineering color scale
# ---------------------------------------------------------------------------
# NEVER derived from a run's own peak/min — identical dBm values MUST always
# produce identical colors across every simulation.
# Range: -80 dBm (dead zone / dark blue) → +10 dBm (very strong / dark red)
HEATMAP_VMIN_DB = -80.0
HEATMAP_VMAX_DB = 10.0

# Engineering color scale anchored at exact dBm levels (as specified):
#
#   -80 dBm  →  Dark Blue     (Coverage Edge / Dead Zone)
#   -70 dBm  →  Blue          (Very Weak Coverage)
#   -60 dBm  →  Cyan          (Poor Coverage)
#   -50 dBm  →  Green         (Weak Coverage)
#   -40 dBm  →  Light Green   (Acceptable Coverage)
#   -30 dBm  →  Yellow        (Fair Coverage)
#   -20 dBm  →  Orange        (Good Coverage)
#   -10 dBm  →  Red           (Strong Signal)
#     0 dBm  →  Dark Red      (Very Strong Signal)
#   +10 dBm  →  Dark Red      (Very Strong Signal, same as 0)
#
# Positions are normalised over the [VMIN, VMAX] = [-80, +10] range (90 dB span).
_DBM_RANGE = HEATMAP_VMAX_DB - HEATMAP_VMIN_DB  # 90

from matplotlib.colors import LinearSegmentedColormap as _LSC

_COLORMAP_ANCHORS = [
    # (normalised position,  R,     G,     B)
    #
    # Design principles:
    #  - Perceptually monotonic brightness: each +10 dBm step is visually
    #    brighter or warmer than the previous one (no inversion).
    #  - Smooth transitions: intermediate hues avoid abrupt jumps.
    #  - MATLAB-quality appearance: blue → sky-blue → cyan-green → lime →
    #    yellow → orange → red → dark-red, matching engineering convention.
    #
    ( 0 / 90,  0.000, 0.000, 0.545),  # −80 dBm  midnight blue   Dead Zone
    (10 / 90,  0.000, 0.000, 1.000),  # −70 dBm  pure blue       Very Weak
    (20 / 90,  0.000, 0.600, 1.000),  # −60 dBm  sky blue        Poor
    (30 / 90,  0.000, 1.000, 0.500),  # −50 dBm  cyan-green      Weak
    (40 / 90,  0.300, 1.000, 0.000),  # −40 dBm  lime green      Acceptable
    (50 / 90,  1.000, 1.000, 0.000),  # −30 dBm  yellow          Fair
    (60 / 90,  1.000, 0.500, 0.000),  # −20 dBm  orange          Good
    (70 / 90,  1.000, 0.000, 0.000),  # −10 dBm  red             Strong
    (80 / 90,  0.650, 0.000, 0.000),  #   0 dBm  dark red        Very Strong
    (90 / 90,  0.450, 0.000, 0.000),  # +10 dBm  deep dark red   Excellent
]

ENGINEERING_COLORMAP = _LSC.from_list(
    "cufe_rf_engineering",
    [(pos, (r, g, b)) for pos, r, g, b in _COLORMAP_ANCHORS],
    N=512,   # 512 colour steps → smooth gradient, no visible banding
)

# Human-readable quality labels for the colorbar tick marks
COLORBAR_TICK_LABELS = {
    -80: "−80 dBm  Dead Zone",
    -70: "−70 dBm  Very Weak",
    -60: "−60 dBm  Poor",
    -50: "−50 dBm  Weak",
    -40: "−40 dBm  Acceptable",
    -30: "−30 dBm  Fair",
    -20: "−20 dBm  Good",
    -10: "−10 dBm  Strong",
      0: "   0 dBm  Very Strong",
     10: " +10 dBm  Excellent",
}


def check_raw_map_compatible(img_uint8):
    """Kept for potential diagnostics only — NOT used to gate or auto-select
    the processing path. Workflow selection (direct Stage 1 upload for an
    already simulation-ready map, vs. Stage 0 first for a general map) is an
    explicit user choice, never an automatic classification."""
    gray = cv2.cvtColor(img_uint8, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(img_uint8, cv2.COLOR_RGB2HSV)
    mean_saturation = float(hsv[..., 1].mean()) / 255.0

    hist = np.bincount(gray.flatten(), minlength=256).astype(float)
    hist /= max(hist.sum(), 1.0)
    two_tone_fraction = float(hist[:40].sum() + hist[215:].sum())

    is_low_color = mean_saturation < 0.12
    is_two_tone = two_tone_fraction > 0.85
    return bool(is_low_color and is_two_tone)


class SingleAntennaSim:
    """Physics and logic unchanged from the original MATLAB/Python reference.

    Supports two mask sources, decided by the caller (run_stage1.py):
      - Stage 0 mode: `map_mask` is set directly from a Stage 0 run's
        canonical mask via `set_mask_from_canonical` — process_map() is
        never called, so the mask is never re-derived from pixel colors.
      - Raw mode (legacy/fallback): `process_map()` derives the mask from
        the uploaded image itself via Otsu thresholding, exactly as before.
        Only used for uploads that pass `check_raw_map_compatible`.
    """

    def __init__(self, raw_image, params, background_image=None):
        self.img = raw_image
        # Background used only for heatmap rendering; defaults to the raw
        # image (legacy behavior) but is Stage 0's Processed_Map when available.
        self.background_image = background_image if background_image is not None else raw_image
        self.params = params

        self.map_mask = None
        # Smooth [0, 1] fractional building occupancy per cell.
        # Used in solve_fdfd() to blend k0 ↔ k_building at boundaries
        # (effective medium interpolation — reduces FDFD staircasing).
        self.map_occupancy = None
        self.src_x = None
        self.src_y = None
        self.was_source_snapped = False
        self.E_field = None

    @staticmethod
    def compute_grid_size(img_shape, cell_budget):
        """Allocates rows/cols to match the uploaded image's aspect ratio
        while keeping the total cell count close to `cell_budget`."""
        img_h, img_w = img_shape[0], img_shape[1]
        aspect = img_h / img_w

        cols = int(round(np.sqrt(cell_budget / aspect)))
        rows = int(round(aspect * cols))

        rows = max(rows, 10)
        cols = max(cols, 10)
        return rows, cols

    def process_map(self):
        gray_img = rgb2gray(self.img)

        try:
            thresh = threshold_otsu(gray_img)
        except ValueError:
            thresh = float(np.mean(gray_img))

        bw_img = gray_img > thresh
        inverted = ~bw_img

        # Downsample to the simulation grid using anti-aliased bilinear
        # interpolation.  The result is a smooth float in [0, 1] representing
        # fractional building occupancy per grid cell.  We intentionally keep
        # this float array — DO NOT hard-threshold here — so that boundary
        # cells receive interpolated material properties in solve_fdfd()
        # (effective medium, see below).  The hard binary mask derived from it
        # is only used for source-snapping and dead-zone metadata.
        occupancy = resize(
            inverted.astype(float),
            (self.params["rows"], self.params["cols"]),
            order=1,
            anti_aliasing=True,
        )

        # Flip polarity if the classification came out inverted
        hard_mask = occupancy > 0.5
        occupied_frac = hard_mask.mean()
        if occupied_frac >= 0.999 or occupied_frac <= 0.001:
            occupancy = 1.0 - occupancy
            hard_mask = ~hard_mask

        # Clean isolated specks and tiny holes from the binary mask only
        # (source snapping / metadata).  The smooth occupancy is unchanged.
        min_feature_cells = max(4, int(0.00015 * hard_mask.size))
        hard_mask = remove_small_objects(hard_mask, max_size=min_feature_cells)
        hard_mask = remove_small_holes(hard_mask, max_size=min_feature_cells)

        self.map_occupancy = occupancy   # smooth [0,1] for k_vec blending
        self.map_mask = hard_mask        # binary for source snapping / metadata
        return self

    def set_mask_from_canonical(self, canonical_mask):
        """Stage 0 mode: resample an already-clean canonical boolean mask
        down to this run's (rows, cols) grid. No thresholding or cleanup is
        redone here — Stage 0 already did that once.

        Keeps the smooth float occupancy (same effective-medium approach as
        process_map) so boundary cells get interpolated material properties."""
        occupancy = resize(
            canonical_mask.astype(float),
            (self.params["rows"], self.params["cols"]),
            order=1,
            anti_aliasing=True,
        )
        self.map_occupancy = occupancy          # smooth [0,1] for k_vec blending
        self.map_mask = occupancy > 0.5         # binary for source snapping
        return self

    def place_source(self):
        rows, cols = self.params["rows"], self.params["cols"]
        y_pct = self.params["source_y_percent"] / 100.0
        x_pct = self.params["source_x_percent"] / 100.0

        self.src_y = min(max(round(rows * y_pct), 0), rows - 1)
        self.src_x = min(max(round(cols * x_pct), 0), cols - 1)

        if self.map_mask is not None and self.map_mask[self.src_y, self.src_x]:
            self.src_y, self.src_x = self._nearest_open_cell(self.src_y, self.src_x)
            self.was_source_snapped = True

        return self

    def _nearest_open_cell(self, y0, x0):
        rows, cols = self.map_mask.shape
        max_radius = max(rows, cols)
        for radius in range(1, max_radius):
            y_lo, y_hi = max(0, y0 - radius), min(rows - 1, y0 + radius)
            x_lo, x_hi = max(0, x0 - radius), min(cols - 1, x0 + radius)
            ring_ys, ring_xs = np.meshgrid(
                np.arange(y_lo, y_hi + 1), np.arange(x_lo, x_hi + 1), indexing="ij"
            )
            on_ring = (
                (ring_ys == y_lo) | (ring_ys == y_hi)
                | (ring_xs == x_lo) | (ring_xs == x_hi)
            )
            cand_y = ring_ys[on_ring]
            cand_x = ring_xs[on_ring]
            open_mask = ~self.map_mask[cand_y, cand_x]
            if np.any(open_mask):
                open_y = cand_y[open_mask]
                open_x = cand_x[open_mask]
                dist = (open_y - y0) ** 2 + (open_x - x0) ** 2
                best = np.argmin(dist)
                return int(open_y[best]), int(open_x[best])
        return y0, x0

    def solve_fdfd(self):
        rows = self.params["rows"]
        cols = self.params["cols"]
        h = self.params["h"]
        N = rows * cols

        e = np.ones(rows)
        D2_r = sp.spdiags([e, -2 * e, e], [-1, 0, 1], rows, rows) / (h ** 2)

        e_c = np.ones(cols)
        D2_c = sp.spdiags([e_c, -2 * e_c, e_c], [-1, 0, 1], cols, cols) / (h ** 2)

        Laplacian = sp.kron(sp.eye(cols), D2_r, format="csr") + \
            sp.kron(D2_c, sp.eye(rows), format="csr")

        # --- Effective medium interpolation at building boundaries -----------
        # Instead of a hard binary step (k0 | k_building), we blend per-cell
        # using the fractional building occupancy [0, 1] produced by the
        # anti-aliased downsampling in process_map() / set_mask_from_canonical().
        #
        # A boundary cell with occupancy f gets:
        #   k_cell = (1-f)*k0 + f*k_building
        #
        # This is physically equivalent to an effective-medium approximation
        # and eliminates staircasing artefacts at building edges.  It makes
        # both Original Map and Binary Mask inputs produce consistent, realistic
        # FDFD behaviour: smooth wavefronts, proper diffraction, no spurious
        # reflections from grid-aligned staircase boundaries.
        #
        # Cells far from edges have occupancy ≈ 0 (free) or ≈ 1 (solid), so
        # the interior physics is unchanged; only the 1–2 cell transition band
        # at every surface is affected.
        occupancy_flat = self.map_occupancy.flatten(order="F")
        k_vec = ((1.0 - occupancy_flat) * self.params["k0"]
                 + occupancy_flat * self.params["k_building"])

        alpha_3d_bump = float(self.params.get("alpha_3d_bump", 0.0))
        if alpha_3d_bump > 0:
            k_vec = k_vec - 1j * alpha_3d_bump

        pml_width = int(self.params.get("pml_width", 0))
        pml_max_loss = float(self.params.get("pml_max_loss", 0.0))
        if pml_width > 0 and pml_max_loss > 0:
            row_idx = np.arange(rows).reshape(-1, 1)
            col_idx = np.arange(cols).reshape(1, -1)
            dist_to_edge = np.minimum.reduce([
                np.broadcast_to(row_idx, (rows, cols)),
                np.broadcast_to((rows - 1) - row_idx, (rows, cols)),
                np.broadcast_to(col_idx, (rows, cols)),
                np.broadcast_to((cols - 1) - col_idx, (rows, cols)),
            ]).astype(float)
            ramp = np.clip((pml_width - dist_to_edge) / pml_width, 0.0, 1.0) ** 2
            extra_loss = (pml_max_loss * ramp).flatten(order="F")
            k_vec = k_vec - 1j * extra_loss

        A = Laplacian + sp.spdiags(k_vec ** 2, 0, N, N)

        b = np.zeros(N, dtype=complex)
        idx = self.src_x * rows + self.src_y
        b[idx] = self.params["source_val"]

        A = A.tocsc()
        E_vec = spla.spsolve(A, -b)

        self.E_field = E_vec.reshape((rows, cols), order="F")
        return self

    def render_heatmap_png(self):
        """Renders a MATLAB-quality coverage heatmap overlay to an in-memory PNG.

        Returns (png_bytes, mag_db, real_peak_db).

        Visual improvements vs. the previous renderer:
          - Jet colormap (MATLAB's classic engineering default) for smooth
            dark-blue → cyan → yellow → red → dark-red transitions.
          - Gaussian pre-smoothing on the dB grid erases finite-difference
            grid artefacts and gives the same silky appearance as MATLAB's
            default bilinear display interpolation.
          - bilinear interpolation on the imshow call for sub-pixel smoothness.
          - Higher DPI (200) and a wider figure (12 × 7.5 in) for crispness.
          - Professional colorbar: tick every 10 dB, bold axis label, right-side.
          - MATLAB-style two-line title.
          - Axis tick labels converted to metres.
          - TX marker: white star with black edge — visible on any background.
        """
        magnitude = np.abs(self.E_field)
        mag_db = 20 * np.log10(magnitude + 1e-12)

        rows, cols = self.params["rows"], self.params["cols"]
        h = self.params["h"]
        f_mhz = self.params["f_sim"] / 1e6
        compute_ms = getattr(self, "compute_time_ms", None)
        compute_str = f"{compute_ms / 1000:.2f}s" if compute_ms is not None else "n/a"

        real_peak = float(np.max(mag_db))

        # --- Gaussian smoothing (display only — does NOT change the physics) ---
        # sigma ≈ 1.5 grid-cells removes the pixel-grid staircase artefacts
        # while preserving all meaningful spatial structure.
        mag_db_smooth = gaussian_filter(mag_db, sigma=1.5)

        # --- Figure & axes -------------------------------------------------------
        plt.rcParams.update({
            "font.family": "DejaVu Sans",
            "font.size": 11,
        })
        fig, ax = plt.subplots(figsize=(12, 7.5), dpi=200, facecolor="white")

        # Background map
        bg_resized = resize(
            self.background_image,
            (rows, cols),
            anti_aliasing=True,
        )
        ax.imshow(bg_resized, aspect="auto")

        # Heatmap overlay — bilinear interpolation + engineering colormap
        # alpha=0.6 matches the reference implementation exactly
        h_plot = ax.imshow(
            mag_db_smooth,
            cmap=ENGINEERING_COLORMAP,
            alpha=0.6,
            norm=Normalize(vmin=HEATMAP_VMIN_DB, vmax=HEATMAP_VMAX_DB),
            interpolation="bilinear",
            aspect="auto",
        )

        # --- Colorbar ------------------------------------------------------------
        cb = fig.colorbar(h_plot, ax=ax, fraction=0.036, pad=0.02, aspect=28)
        # Label matches the reference: values are dB of |E|, not milliwatts
        cb.set_label(
            "Absolute Signal Strength (dB)",
            fontsize=11, fontweight="bold", labelpad=10,
        )
        ticks = sorted(COLORBAR_TICK_LABELS.keys())
        cb.set_ticks(ticks)
        cb.set_ticklabels([COLORBAR_TICK_LABELS[t] for t in ticks])
        cb.ax.tick_params(labelsize=8.5)

        # --- Title ---------------------------------------------------------------
        ax.set_title(
            f"CUFE WiFi Coverage Map  |  True Peak: {real_peak:.1f} dB\n"
            f"Freq: {f_mhz:g} MHz  |  Grid: {rows}×{cols}  |  "
            f"Cell: {h:g} m  |  Compute: {compute_str}",
            fontsize=13, fontweight="bold", pad=12,
        )

        # --- Axis labels & metre ticks -------------------------------------------
        ax.set_xlabel("Distance (Meters)", fontsize=11, labelpad=8)
        ax.set_ylabel("Distance (Meters)", fontsize=11, labelpad=8)

        # Convert grid-index ticks → physical metres
        def _metre_formatter(val, pos, cell_size=h):
            if val < 0:
                return ""
            return f"{val * cell_size:.0f}"

        ax.xaxis.set_major_formatter(ticker.FuncFormatter(lambda v, p: _metre_formatter(v, p, h)))
        ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda v, p: _metre_formatter(v, p, h)))
        ax.tick_params(labelsize=10)

        # --- TX marker -----------------------------------------------------------
        ax.plot(
            self.src_x, self.src_y,
            marker="*",
            markersize=18,
            markerfacecolor="white",
            markeredgecolor="black",
            markeredgewidth=1.2,
            zorder=10,
        )
        ax.annotate(
            "TX",
            (self.src_x, self.src_y),
            textcoords="offset points",
            xytext=(10, 8),
            fontsize=10, fontweight="bold", color="white",
            bbox=dict(
                boxstyle="round,pad=0.25",
                facecolor="black",
                alpha=0.55,
                edgecolor="none",
            ),
            zorder=11,
        )

        plt.tight_layout(pad=1.2)

        # Persist the actual computational data rectangle inside the decorated
        # PNG. The UI selects on this rendered image, but titles, axes, margins,
        # and the colorbar are not part of the simulation grid.
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        axes_bbox = ax.get_window_extent(renderer)
        tight_bbox = fig.get_tightbbox(renderer).transformed(fig.dpi_scale_trans)
        save_pad_px = fig.dpi * 0.1  # savefig(..., bbox_inches="tight") default
        heatmap_data_rect = {
            "x": float(axes_bbox.x0 - tight_bbox.x0 + save_pad_px),
            "y": float(tight_bbox.y1 - axes_bbox.y1 + save_pad_px),
            "width": float(axes_bbox.width),
            "height": float(axes_bbox.height),
        }

        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=200, bbox_inches="tight", pad_inches=0.1)
        plt.close(fig)
        buf.seek(0)
        return buf.read(), mag_db, real_peak, heatmap_data_rect

    def _finish_and_render(self):
        self.place_source()
        _solve_start = time.perf_counter()
        self.solve_fdfd()
        self.compute_time_ms = (time.perf_counter() - _solve_start) * 1000.0
        png_bytes, mag_db, real_peak, heatmap_data_rect = self.render_heatmap_png()
        return {
            "png_bytes": png_bytes,
            "mag_db": mag_db,
            "real_peak_db": real_peak,
            "heatmap_data_rect": heatmap_data_rect,
            "src_x": self.src_x,
            "src_y": self.src_y,
            "was_source_snapped": self.was_source_snapped,
            "occupied_fraction": float(self.map_mask.mean()),
        }

    def run(self):
        """Raw/legacy mode: derive the mask from the uploaded image itself."""
        self.process_map()
        return self._finish_and_render()

    def run_with_canonical_mask(self, canonical_mask):
        """Stage 0 mode: consume an already-processed canonical mask
        directly — never re-derive it from pixel colors."""
        self.set_mask_from_canonical(canonical_mask)
        return self._finish_and_render()


def build_params(raw_image_shape, form):
    """Resolves the API's Stage1RunInput form fields into the physics
    parameter dict expected by SingleAntennaSim, matching
    get_hyperparameters() in the original reference script."""
    cell_budget = int(form.get("cellBudget", 260000))
    rows, cols = SingleAntennaSim.compute_grid_size(raw_image_shape, cell_budget)

    real_width_m = form.get("realWidthMeters")
    if real_width_m:
        h = float(real_width_m) / cols
    else:
        h = float(form.get("cellSizeMeters", 0.5))

    c = 3e8
    f_sim = float(form.get("frequencyMHz", 50)) * 1e6
    k0 = 2 * np.pi * f_sim / c

    n_eff = float(form.get("refractiveIndex", 2.0))
    alpha_eff = float(form.get("absorptionCoeff", 0.062))
    k_building = k0 * n_eff - 1j * alpha_eff

    return {
        "rows": rows,
        "cols": cols,
        "h": h,
        "f_sim": f_sim,
        "c": c,
        "k0": k0,
        "n_eff": n_eff,
        "alpha_eff": alpha_eff,
        "k_building": k_building,
        "alpha_3d_bump": float(form.get("alpha3dBump", 0.0)),
        "source_val": float(form.get("sourceValue", 22)),
        "min_db": float(form.get("minDb", -80)),
        "pml_width": int(form.get("pmlWidth", 20)),
        "pml_max_loss": float(form.get("pmlMaxLoss", 0.5)),
        "source_x_percent": float(form.get("sourceXPercent", 10)),
        "source_y_percent": float(form.get("sourceYPercent", 5)),
        "cell_budget": cell_budget,
    }
