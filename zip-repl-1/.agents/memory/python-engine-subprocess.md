---
name: Porting a scientific Python solver into a TS monorepo
description: When and how to wrap an existing Python numerical/scientific script as a subprocess engine called from a Node/Express API, instead of reimplementing it in TypeScript.
---

## Rule
If a reference script's core computation depends on Python scientific libraries with no faithful JS equivalent (e.g. `scipy.sparse.linalg.spsolve` on a sparse system, `skimage` thresholding/morphology), keep that computation in Python and invoke it as a headless CLI subprocess from the Node/Express server. Do not port the math to TypeScript.

**Why:** Reimplementing sparse linear solves or image-segmentation routines by hand risks silently changing the numerical result in ways that are hard to detect (no error, just a different answer). Preserving the original library calls preserves correctness with near-zero verification burden — the physics is provably unchanged because it's the same code path, just stripped of notebook/GUI/dashboard scaffolding.

**How to apply:**
- Strip the reference script down to a pure function/CLI (remove Colab/ipywidgets/dashboard/plotting-for-humans code), keep the actual algorithm untouched.
- Give the CLI a narrow contract: `python3 script.py <input> <params.json> <output_dir>`, non-zero exit + JSON-on-stderr for errors, JSON result file on success.
- Call it from a Node service with a hard timeout, capture stdout/stderr, and parse the result file rather than parsing stdout for data.
- Treat any endpoint that shells out to this subprocess as synchronous and potentially slow (seconds to over a minute depending on input size) — set server-side timeouts and make sure the frontend has a real loading state, not an optimistic fast-response assumption.
- Persist expensive outputs (images, arrays) to per-run disk directories rather than recomputing on every read, so later pipeline stages can reuse a prior run's result via an id.
