---
name: ROI coordinate contract
description: How rendered Stage 1 heatmap selections map to the simulation grid
---

The Stage 1 visualization is a decorated presentation image, not a direct grid
image. ROI coordinates from the UI must be clamped to the persisted
computational data rectangle (the Matplotlib axes/data area) before converting
to FDFD grid coordinates.

**Why:** Titles, axes, margins, and colorbars occupy pixels in the rendered
PNG. Treating the full PNG as the grid shifts crops and can put non-simulation
pixels into the computational domain.

**How to apply:** Persist the renderer's exact data rectangle with each Stage 1
run, have the crop service reject old runs without that geometry, and keep
Stage 2/3 coordinates relative to the resulting cropped grid.