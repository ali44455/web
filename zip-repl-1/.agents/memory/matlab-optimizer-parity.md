---
name: MATLAB optimizer parity
description: Important differences between the original MATLAB NodePlacerOptimizer and the current Python port
---

The original MATLAB optimizer is not equivalent to the notebook-derived Python optimizer. It uses 8-connected clusters, MATLAB defaults, interior air candidates, a cluster-coverage radius sweep, sector-aware minimum-set-cover ILP, strict boundary filtering, RF sector pruning, and cluster-based coverage.

**Why:** A same-ROI audit showed that production can coincidentally return the same node count while selecting positions outside MATLAB's interior/candidate constraints and reporting a different coverage metric.

**How to apply:** Treat the uploaded MATLAB class as the algorithm authority for any future parity work. Do not infer MATLAB equivalence from notebook parity or from matching node counts alone.

The production port uses SciPy `milp` as the solver backend for MATLAB's
`intlinprog` models. The model structure and fallback logic are preserved, but
solver tie-breaking and floating-point/image-resampling details are not
guaranteed to be bit-for-bit identical without MATLAB/Octave.

**Why:** MATLAB/Octave is unavailable in the runtime, so the exact proprietary
solver execution and default tie-breaking cannot be replayed directly.

**How to apply:** Treat node sets with equal objective value as solver-dependent
unless they are uniquely determined by the constraints; compare objective,
coverage, constraints, and processing outputs rather than assuming identical
candidate ordering proves identical solver behavior.