---
name: Fixed (non-rescaling) color scales for engineering visualizations
description: When a heatmap/coverage-map's color must mean the same physical value across every run, never normalize per-run min/max.
---

For an engineering/physical visualization (RF coverage, thermal, stress, etc.), if the same
underlying value (e.g. -50 dB) needs to look the same color on every run so users can compare
runs at a glance, the color normalization bounds (vmin/vmax) must be fixed constants — never
derived from that run's own `min()`/`max()` (e.g. `vmax = max(20, real_peak)`).

**Why:** Per-run normalization makes color meaningless across runs — a "green" zone in one run
might be a "red" zone in another purely because the peak signal differed, which defeats the
purpose of a shared visual language for comparing/reviewing multiple runs.

**How to apply:** Before hardcoding a suggested numeric range from a spec (e.g. "-80 to +10"),
sanity-check it against the actual solver's typical output on a representative run — don't assume
a spec's numbers transfer directly if the underlying quantity isn't in the same physical units
the spec assumed (e.g. an "absolute signal strength" unit that isn't calibrated real-world dBm).
If the typical range does line up, use the fixed bounds as-is; if not, pick different fixed
bounds calibrated to the actual solver, but keep them fixed regardless.
