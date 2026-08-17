"""
FILE: stage0_engine.py

Stage 0 — Map Processing. Fully automatic. Converts any supported map style
(AI-generated campus renders, satellite/Google-Maps-style images, CAD
floor/site plans, colored campus layouts) into a standardized pair of
outputs that Stage 1 consumes directly:

  - Processed_Map: a clean, flat, engineering-style rendering (buildings /
    roads / open ground each rendered in one flat color).
  - BinaryMask: the detected building/obstruction mask, at a fixed canonical
    resolution independent of any later simulation grid size.

This is a heuristic classical image-processing pipeline (adaptive
thresholding + contour shape filtering + morphology), not a trained
segmentation model — there is no labeled training data available in this
project. It is tuned to work well on maps with visually distinct buildings,
roads, and open ground (which covers the styles listed above), but will not
perfectly segment arbitrary artistic or photographic maps. No values are
hardcoded to one specific image: every threshold below is either adaptive
(computed from the image itself) or a small multiplier applied to the
image's own dimensions/statistics.

Road vs. open-ground classification is best-effort and cosmetic only (it
only affects how Processed_Map.png looks); Stage 1's physics only consumes
the building/obstruction mask, since RF propagation only cares about what is
solid vs. passable.
"""

import time

import cv2
import numpy as np
from skimage.morphology import (
    remove_small_objects,
    remove_small_holes,
    opening,
    disk,
)
from skimage.filters import gaussian

# Cap the canonical processing resolution so segmentation stays fast and
# consistent regardless of the uploaded image's native size. Stage 1 resizes
# this canonical mask down to whatever grid size its cellBudget calls for —
# it never re-derives the mask from pixel colors.
CANONICAL_MAX_DIM = 1200

# Flat colors for the standardized Processed_Map rendering (RGB), matching
# the simulator's native map style: white background, very light gray
# buildings, light blue-gray roads, subtle outlines — a clean engineering
# drawing, not a realistic/decorative rendering.
COLOR_OPEN = (255, 255, 255)
COLOR_ROAD = (198, 210, 219)
COLOR_BUILDING = (222, 224, 226)
COLOR_BUILDING_OUTLINE = (150, 152, 156)

# A filled contour is kept as a building only if it is reasonably box-like:
# area relative to its own bounding box ("extent") is high. This is what
# separates compact building footprints from thin, image-spanning shapes
# (road networks, page borders) that adaptive thresholding also picks up as
# "ink" but which are not buildings.
MIN_BUILDING_EXTENT = 0.35


def _resize_to_canonical(img_uint8: np.ndarray) -> np.ndarray:
    h, w = img_uint8.shape[:2]
    scale = CANONICAL_MAX_DIM / max(h, w)
    if scale < 1.0:
        new_w, new_h = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        return cv2.resize(img_uint8, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img_uint8


def _segment_buildings(img_uint8: np.ndarray) -> np.ndarray:
    """Adaptive, shape-filtered building-footprint segmentation. Returns a
    boolean mask, True = building/obstruction."""
    gray = cv2.cvtColor(img_uint8, cv2.COLOR_RGB2GRAY)
    denoised = cv2.bilateralFilter(gray, d=7, sigmaColor=50, sigmaSpace=50)

    # Adaptive threshold: robust to varying brightness/color across the map,
    # unlike a single global cutoff. Block size scales with image size.
    block = max(11, (min(denoised.shape) // 15) | 1)  # must be odd
    adaptive = cv2.adaptiveThreshold(
        denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 5,
    )

    # Otsu as a secondary cue — catches globally dark/solid footprints that
    # adaptive thresholding's local window can under-detect.
    _, otsu = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    combined = cv2.bitwise_or(adaptive, otsu)

    # Merge wall/outline pixels into solid footprints, then drop pixel noise.
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(closed)
    img_area = closed.shape[0] * closed.shape[1]
    min_area = max(30.0, img_area * 0.0008)

    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        _, _, bw, bh = cv2.boundingRect(c)
        bbox_area = float(bw * bh)
        if bbox_area <= 0:
            continue
        # Extent (area / own bounding-box area): a rectangular building
        # footprint fills nearly all of its bounding box (extent ~0.7-1.0).
        # Thin, image-spanning structures like road networks or a page
        # border occupy a large bounding box but very little of it, so their
        # extent is low — this is what keeps roads out of the building mask
        # without needing any hardcoded color/shape assumptions.
        extent = area / bbox_area
        if extent >= MIN_BUILDING_EXTENT:
            cv2.drawContours(filled, [c], -1, 255, thickness=cv2.FILLED)

    mask = filled > 0
    mask = remove_small_holes(mask, area_threshold=int(min_area))
    mask = remove_small_objects(mask, min_size=int(min_area))

    # Smooth jagged pixel-level edges into cleaner, drafted-looking boundaries.
    smoothed = gaussian(mask.astype(float), sigma=1.5)
    mask = smoothed > 0.5

    return mask


def _segment_roads(non_building: np.ndarray) -> np.ndarray:
    """Best-effort, cosmetic-only road/walkway detection: thin, elongated
    non-building regions that vanish under a moderate morphological opening
    ("residue of opening" — isolates locally thin structures)."""
    if not non_building.any():
        return np.zeros_like(non_building)

    radius = max(3, min(non_building.shape) // 120)
    opened = opening(non_building, disk(radius))
    return non_building & ~opened


def _render_processed_map(building_mask: np.ndarray, road_mask: np.ndarray) -> np.ndarray:
    h, w = building_mask.shape
    out = np.empty((h, w, 3), dtype=np.uint8)
    out[:] = COLOR_OPEN
    out[road_mask] = COLOR_ROAD
    out[building_mask] = COLOR_BUILDING

    # Draw a slightly darker outline around each building for definition.
    building_u8 = (building_mask * 255).astype(np.uint8)
    contours, _ = cv2.findContours(building_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, contours, -1, COLOR_BUILDING_OUTLINE, thickness=1)
    return out


def _render_binary_mask_png(building_mask: np.ndarray) -> np.ndarray:
    """White = building/obstruction, black = free space (standard occupancy
    grid convention)."""
    return (building_mask * 255).astype(np.uint8)


def run(raw_image_rgb: np.ndarray) -> dict:
    """Runs the full Stage 0 pipeline against a raw uploaded map image.
    Returns processed_map (uint8 RGB array), binary_mask_png (uint8 grayscale
    array), building_mask (bool array, the canonical mask Stage 1 consumes),
    and metadata."""
    start = time.perf_counter()

    canonical = _resize_to_canonical(raw_image_rgb)
    building_mask = _segment_buildings(canonical)
    road_mask = _segment_roads(~building_mask)
    open_mask = (~building_mask) & (~road_mask)

    processed_map = _render_processed_map(building_mask, road_mask)
    binary_mask_png = _render_binary_mask_png(building_mask)

    execution_time_ms = (time.perf_counter() - start) * 1000.0
    h, w = building_mask.shape

    return {
        "processed_map": processed_map,
        "binary_mask_png": binary_mask_png,
        "building_mask": building_mask,
        "execution_time_ms": execution_time_ms,
        "metadata": {
            "widthPx": int(w),
            "heightPx": int(h),
            "buildingCoverageFraction": float(building_mask.mean()),
            "roadCoverageFraction": float(road_mask.mean()),
            "openAreaFraction": float(open_mask.mean()),
        },
    }
