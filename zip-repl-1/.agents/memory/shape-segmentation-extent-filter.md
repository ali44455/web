---
name: Extent filter beats compactness for separating blobs from thin networks
description: When classical-CV segmentation must keep compact filled shapes (building footprints) but reject thin, image-spanning structures (roads, borders) from the same threshold mask.
---

When segmenting a binary/thresholded image into "compact blob" objects (e.g. building footprints)
vs. "thin, spanning" structures (e.g. road networks, page borders) that got picked up by the same
threshold, isoperimetric **compactness** (`4π·area/perimeter²`) is a weak discriminator — a cross
or grid-like road network can still score above lenient compactness thresholds.

**Why:** Compactness only measures perimeter-to-area ratio, which doesn't strongly penalize a
shape that is locally thin but sprawls across most of the image.

**How to apply:** Use **extent** instead: `area / own_bounding_box_area` (via
`cv2.boundingRect`). A rectangular building fills nearly all of its own bounding box
(extent ~0.5-1.0). A road cross or border spanning the whole image occupies a huge bounding box
but only a small fraction of it (extent often <0.15) — a much stronger and simpler separator than
compactness for this specific "compact blob vs. thin spanning network" case.
