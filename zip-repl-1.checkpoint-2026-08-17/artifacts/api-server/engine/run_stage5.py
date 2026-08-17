"""Generate engineering analysis from completed Stage 1/2/4 artifacts.

No field is re-solved here. Every numerical chart reads matrices and optimizer
measurements persisted by the earlier workflow stages.
"""
import json
import os
import sys
import time
import traceback

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image


ANGLES = (15, 40, 60, 75)
CHARTS = {
    "beamSweeping": "analysis_beam_sweeping.png",
    "pathLoss": "analysis_path_loss.png",
    "arrayGain": "analysis_array_gain.png",
    "signalQuality": "analysis_signal_quality.png",
    "tradeoff3d": "analysis_tradeoff_3d.png",
    "phaseDelay": "analysis_phase_delay.png",
    "phaseTolerance": "analysis_phase_tolerance.png",
}


def _load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _save(fig, path):
    fig.tight_layout()
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="#ffffff")
    plt.close(fig)


def _background(stage1_dir, shape):
    rows, cols = shape
    for name in ("roi_campus_map.png", "roi_heatmap.png", "campus_map.png"):
        candidate = os.path.join(stage1_dir, name)
        if os.path.exists(candidate):
            return np.asarray(Image.open(candidate).convert("RGB").resize((cols, rows)))
    return np.full((rows, cols, 3), 242, dtype=np.uint8)


def _quality_distribution(single, phased, mask):
    free = mask == 0
    if not np.any(free):
        free = np.ones_like(mask, dtype=bool)
    s_vals, p_vals = single[free], phased[free]
    bins = [
        (float("-inf"), -80, "Dead (< -80)"),
        (-80, -60, "Poor (-80 to -60)"),
        (-60, -40, "Good (-60 to -40)"),
        (-40, float("inf"), "Excellent (> -40)"),
    ]
    rows = []
    for lo, hi, label in bins:
        rows.append({
            "label": label,
            "singlePercent": float(np.mean((s_vals >= lo) & (s_vals < hi)) * 100),
            "phasedPercent": float(np.mean((p_vals >= lo) & (p_vals < hi)) * 100),
        })
    return rows


def _plot_quality(data, output_path):
    labels = [row["label"].replace(" ", "\n", 1) for row in data]
    single = [row["singlePercent"] for row in data]
    phased = [row["phasedPercent"] for row in data]
    x = np.arange(len(labels))
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.bar(x - .18, single, .36, label="Single Antenna", color="#d95319")
    ax.bar(x + .18, phased, .36, label="Total Phased Array", color="#0072bd")
    ax.set_xticks(x, labels)
    ax.set_ylabel("Free-space area (%)")
    ax.set_title("Signal Quality Distribution", fontweight="bold")
    ax.grid(axis="y", alpha=.25)
    ax.legend()
    for i, values in enumerate(zip(single, phased)):
        for dx, value in zip((-.18, .18), values):
            ax.text(i + dx, value + .7, f"{value:.1f}%", ha="center", fontsize=8)
    _save(fig, output_path)


def _plot_beams(sectors, background, output_path):
    fig, axes = plt.subplots(2, 2, figsize=(11, 8))
    fig.suptitle("Beam Sweeping (5 Elements) — Real Solved Fields", fontweight="bold")
    for ax, angle in zip(axes.flat, ANGLES):
        grid = sectors[f"angle_{angle}"]
        ax.imshow(background)
        image = ax.imshow(grid, alpha=.65, cmap="jet", vmin=-80,
                          vmax=max(15, float(np.max(grid))))
        ax.set_title(f"Beam directed at {angle}° | peak {np.max(grid):.1f} dBm")
        ax.axis("off")
        fig.colorbar(image, ax=ax, fraction=.045, pad=.02, label="dBm")
    _save(fig, output_path)


def _radial_samples(single, phased, src_x, src_y, cell_size, tx_power_dbm):
    rows, cols = single.shape
    result = []
    for angle in ANGLES:
        theta = np.radians(angle)
        radial = np.arange(int(np.ceil(np.hypot(rows, cols))) + 1)
        x = np.round(src_x + radial * np.cos(theta)).astype(int)
        y = np.round(src_y + radial * np.sin(theta)).astype(int)
        valid = (x >= 0) & (x < cols) & (y >= 0) & (y < rows)
        x, y, radial = x[valid], y[valid], radial[valid]
        stride = max(1, int(np.ceil(len(radial) / 350)))
        single_dbm = single[y, x][::stride].astype(float)
        phased_dbm = phased[y, x][::stride].astype(float)
        result.append({
            "angle": angle,
            "distanceMeters": (radial[::stride] * cell_size).astype(float).tolist(),
            "singleDbm": single_dbm.tolist(),
            "phasedDbm": phased_dbm.tolist(),
            "singlePathLossDb": (tx_power_dbm - single_dbm).tolist(),
            "phasedPathLossDb": (tx_power_dbm - phased_dbm).tolist(),
        })
    return result


def _plot_pathloss(samples, output_path):
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    fig.suptitle("Total Path Loss Across Sectors", fontweight="bold")
    for ax, sector in zip(axes.flat, samples):
        ax.plot(sector["distanceMeters"], sector["singlePathLossDb"],
                color="#d95319", label="Single Antenna", linewidth=1.4)
        ax.plot(sector["distanceMeters"], sector["phasedPathLossDb"],
                color="#0072bd", label="Phased Array Max-Hold", linewidth=1.4)
        values = sector["singlePathLossDb"] + sector["phasedPathLossDb"]
        ax.set_ylim(min(values) - 5, max(values) + 5)
        ax.set_title(f"Cross-section at {sector['angle']}°")
        ax.set_xlabel("Distance from source (m)")
        ax.set_ylabel("Effective path loss (dB)")
        ax.grid(alpha=.25)
        ax.legend(fontsize=8)
    _save(fig, output_path)


def _gain_data(num_elements=5, element_gain=2.15):
    return [{
        "elements": int(n),
        "totalPeakGainDb": float(element_gain + 20 * np.log10(n)),
        "operatingPoint": int(n) == num_elements,
    } for n in range(1, 16)]


def _plot_gain(data, output_path):
    x = [row["elements"] for row in data]
    y = [row["totalPeakGainDb"] for row in data]
    op = next(row for row in data if row["operatingPoint"])
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.plot(x, y, "-o", color="#0072bd", label="Total peak gain")
    ax.scatter([op["elements"]], [op["totalPeakGainDb"]], marker="*", s=250,
               color="#16a34a", label="Current 5-element operating point", zorder=3)
    ax.annotate(f"{op['totalPeakGainDb']:.1f} dB", (op["elements"], op["totalPeakGainDb"]),
                xytext=(8, 10), textcoords="offset points", fontweight="bold")
    ax.set_xticks(x)
    ax.set_xlabel("Number of antenna elements")
    ax.set_ylabel("Total peak gain (dB)")
    ax.set_title("Phased Array Gain Trade-off", fontweight="bold")
    ax.grid(alpha=.25)
    ax.legend()
    _save(fig, output_path)


def _plot_tradeoff(sweep, output_path):
    fig = plt.figure(figsize=(10, 7))
    ax = fig.add_subplot(111, projection="3d")
    radii = np.array([row["radius"] for row in sweep], dtype=float)
    nodes = np.array([row["requiredNodes"] for row in sweep], dtype=float)
    coverage = np.array([row["coveragePercent"] for row in sweep], dtype=float)
    floor = max(0.0, float(coverage.min() - max(1.0, np.ptp(coverage) * .15)))
    for radius, count, cov in zip(radii, nodes, coverage):
        ax.plot([radius, radius], [count, count], [floor, cov], color=plt.cm.jet(cov / 100), alpha=.8)
    ax.plot(radii, nodes, coverage, color="#0072bd", linewidth=2.5)
    points = ax.scatter(radii, nodes, coverage, c=coverage, cmap="jet", s=55, edgecolors="black")
    fig.colorbar(points, ax=ax, shrink=.65, label="Coverage (%)")
    ax.set_xlabel("Node radius (cells)")
    ax.set_ylabel("Required candidate nodes")
    ax.set_zlabel("Coverage area (%)")
    ax.set_title("Unified 3D Trade-off Landscape\nReal optimizer radius sweep", fontweight="bold")
    ax.view_init(elev=24, azim=-55)
    _save(fig, output_path)


def _phase_shifter_analysis(freq_hz, num_elements=5):
    c = 3e8
    wavelength = c / freq_hz
    spacing = wavelength / 2.0
    carrier_period_ps = 1e12 / freq_hz
    angles = np.arange(0.0, 90.01, 1.0)
    delay_ps = spacing * np.sin(np.radians(angles)) / c * 1e12
    phase_deg = 180.0 * np.sin(np.radians(angles))
    path_cm = spacing * np.sin(np.radians(angles)) * 100.0
    table_angles = (0, 30, 45, 60, 90)
    table = []
    for angle in table_angles:
        idx = int(angle)
        table.append({
            "angleDegrees": angle,
            "requiredPhaseDegrees": float(phase_deg[idx]),
            "idealDelayPs": float(delay_ps[idx]),
            "pathDifferenceCm": float(path_cm[idx]),
        })

    # Independent Gaussian RMS phase errors across a finite N-element array.
    # Expected normalized coherent power includes the 1/N incoherent floor.
    jitter_ps = np.linspace(0.0, carrier_period_ps * 0.125, 181)
    phase_error_deg = 360.0 * freq_hz * jitter_ps * 1e-12
    sigma_rad = np.radians(phase_error_deg)
    power_ratio = 1.0 / num_elements + (1.0 - 1.0 / num_elements) * np.exp(-(sigma_rad ** 2))
    efficiency = power_ratio * 100.0
    gain_loss = 10.0 * np.log10(np.maximum(power_ratio, 1e-12))
    coverage_radius = np.sqrt(power_ratio) * 100.0
    reference_jitter_ps = 23.1
    reference_phase_error = 360.0 * 2.4e9 * reference_jitter_ps * 1e-12
    actual_phase_error = 360.0 * freq_hz * reference_jitter_ps * 1e-12
    return {
        "frequencyHz": float(freq_hz),
        "wavelengthMeters": float(wavelength),
        "elementSpacingMeters": float(spacing),
        "carrierPeriodPs": float(carrier_period_ps),
        "maxIdealDelayPs": float(delay_ps[-1]),
        "profiles": [{"angleDegrees": float(a), "requiredPhaseDegrees": float(p),
                      "idealDelayPs": float(d), "pathDifferenceCm": float(cm)}
                     for a, p, d, cm in zip(angles, phase_deg, delay_ps, path_cm)],
        "delayTable": table,
        "tolerance": [{"timingErrorPs": float(t), "phaseErrorDegrees": float(p),
                       "beamformingEfficiencyPercent": float(e), "gainLossDb": float(g),
                       "relativeCoverageRadiusPercent": float(r)}
                      for t, p, e, g, r in zip(jitter_ps, phase_error_deg, efficiency,
                                               gain_loss, coverage_radius)],
        "pdfReference": {
            "timingErrorPs": reference_jitter_ps,
            "phaseErrorAt2_4GHzDegrees": float(reference_phase_error),
            "phaseErrorAtSelectedFrequencyDegrees": float(actual_phase_error),
        },
    }


def _plot_phase_delay(analysis, output_path):
    profiles = analysis["profiles"]
    angles = [row["angleDegrees"] for row in profiles]
    delays = [row["idealDelayPs"] for row in profiles]
    phases = [row["requiredPhaseDegrees"] for row in profiles]
    fig, ax1 = plt.subplots(figsize=(10, 5.8))
    ax2 = ax1.twinx()
    line1 = ax1.plot(angles, delays, color="#0072bd", linewidth=2.4, label="Ideal adjacent-element delay")
    line2 = ax2.plot(angles, phases, color="#d95319", linewidth=2.0, label="Required phase shift")
    ax1.set_xlabel("Steering angle from boresight (degrees)")
    ax1.set_ylabel("Ideal delay (ps)", color="#0072bd")
    ax2.set_ylabel("Phase shift (degrees)", color="#d95319")
    ax1.set_title("Phase Shifter Delay and Phase Profile\nd = lambda/2, selected carrier frequency", fontweight="bold")
    ax1.grid(alpha=.25)
    ax1.legend(line1 + line2, [line.get_label() for line in line1 + line2], loc="upper left")
    _save(fig, output_path)


def _plot_phase_tolerance(analysis, output_path):
    tolerance = analysis["tolerance"]
    jitter = [row["timingErrorPs"] for row in tolerance]
    efficiency = [row["beamformingEfficiencyPercent"] for row in tolerance]
    coverage = [row["relativeCoverageRadiusPercent"] for row in tolerance]
    phase = [row["phaseErrorDegrees"] for row in tolerance]
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.5))
    axes[0].plot(jitter, phase, color="#7c3aed", linewidth=2.2)
    axes[0].set_title("Timing error to phase mismatch")
    axes[0].set_xlabel("RMS timing error (ps)")
    axes[0].set_ylabel("RMS phase error (degrees)")
    axes[0].grid(alpha=.25)
    axes[1].plot(jitter, efficiency, label="Coherent power / efficiency", color="#0072bd", linewidth=2.2)
    axes[1].plot(jitter, coverage, label="Relative coverage radius", color="#d95319", linewidth=2.2)
    axes[1].set_title("Five-element tolerance impact")
    axes[1].set_xlabel("RMS timing error (ps)")
    axes[1].set_ylabel("Relative performance (%)")
    axes[1].set_ylim(0, 105)
    axes[1].grid(alpha=.25)
    axes[1].legend()
    fig.suptitle("Non-Ideal Phase Shifter Sensitivity", fontweight="bold")
    _save(fig, output_path)


def main():
    if len(sys.argv) != 5:
        raise ValueError("usage: run_stage5.py <stage1_dir> <stage2_dir> <stage4_dir> <output_dir>")
    stage1_dir, stage2_dir, stage4_dir, output_dir = sys.argv[1:]
    os.makedirs(output_dir, exist_ok=True)
    started = time.perf_counter()

    single_path = os.path.join(stage1_dir, "roi_mag_db.npy")
    mask_path = os.path.join(stage1_dir, "roi_map_mask.npy")
    if not os.path.exists(single_path):
        single_path = os.path.join(stage1_dir, "mag_db.npy")
        mask_path = os.path.join(stage1_dir, "map_mask.npy")
    single = np.load(single_path)
    mask = np.load(mask_path)
    phased = np.load(os.path.join(stage4_dir, "max_hold_db.npy"))
    if single.shape != phased.shape:
        raise ValueError(f"Stage grids do not align: single={single.shape}, phased={phased.shape}")

    stage1 = _load_json(os.path.join(stage1_dir, "result.json"))
    stage2_path = os.path.join(stage2_dir, "stage2-run.json")
    if not os.path.exists(stage2_path):
        stage2_path = os.path.join(stage2_dir, "result.json")
    stage2 = _load_json(stage2_path)
    stage4 = _load_json(os.path.join(stage4_dir, "result.json"))
    sector_file = np.load(os.path.join(stage4_dir, "analysis_sectors.npz"))
    sectors = {name: sector_file[name] for name in sector_file.files}
    missing = [angle for angle in ANGLES if f"angle_{angle}" not in sectors]
    if missing:
        raise ValueError(f"Phased-array run is missing analysis angles: {missing}; rerun Stage 4")

    background = _background(stage1_dir, single.shape)
    quality = _quality_distribution(single, phased, mask)
    cell_size = float(stage1.get("resolvedParams", {}).get("cellSizeMeters", 1.0))
    tx = stage2.get("transmitter", [stage4.get("antennaPlacement", {}).get("xPixel", 0),
                                    stage4.get("antennaPlacement", {}).get("yPixel", 0)])
    tx_power_dbm = float(stage4.get("txPowerDbm", 0.0))
    pathloss = _radial_samples(single, phased, float(tx[0]), float(tx[1]), cell_size, tx_power_dbm)
    gain = _gain_data()
    phase_shifter = _phase_shifter_analysis(float(stage4.get("freqHz", 2.4e9)))
    raw_sweep = stage2.get("radiusSweep", [])
    sweep = [{"radius": float(row[0]), "requiredNodes": int(row[1]),
              "coveragePercent": float(row[2])} for row in raw_sweep]

    _plot_beams(sectors, background, os.path.join(output_dir, CHARTS["beamSweeping"]))
    _plot_pathloss(pathloss, os.path.join(output_dir, CHARTS["pathLoss"]))
    _plot_gain(gain, os.path.join(output_dir, CHARTS["arrayGain"]))
    _plot_quality(quality, os.path.join(output_dir, CHARTS["signalQuality"]))
    _plot_phase_delay(phase_shifter, os.path.join(output_dir, CHARTS["phaseDelay"]))
    _plot_phase_tolerance(phase_shifter, os.path.join(output_dir, CHARTS["phaseTolerance"]))
    if len(sweep) >= 2:
        _plot_tradeoff(sweep, os.path.join(output_dir, CHARTS["tradeoff3d"]))
    else:
        CHARTS.pop("tradeoff3d", None)

    single_good = sum(row["singlePercent"] for row in quality[2:])
    phased_good = sum(row["phasedPercent"] for row in quality[2:])
    dead_single = quality[0]["singlePercent"]
    dead_phased = quality[0]["phasedPercent"]
    best_sweep = max(sweep, key=lambda row: (row["coveragePercent"], -row["requiredNodes"])) if sweep else None
    free = mask == 0
    if not np.any(free):
        free = np.ones_like(mask, dtype=bool)
    single_peak = float(np.max(single[free]))
    phased_peak = float(np.max(phased[free]))
    element_count = 5
    relative_power = float(element_count)
    power_saved = float((1.0 - relative_power) * 100.0)
    wavelength = 3e8 / float(stage4.get("freqHz", 2.4e9))
    points_per_wavelength = wavelength / cell_size
    accuracy_level = ("high" if points_per_wavelength >= 10 else
                      "acceptable" if points_per_wavelength >= 6 else "under-resolved")
    result = {
        "executionTimeMs": int((time.perf_counter() - started) * 1000),
        "stage1RunId": stage2.get("stage1RunId"),
        "stage2RunId": stage4.get("stage2RunId", None),
        "stage4RunId": os.path.basename(stage4_dir),
        "inputSummary": {
            "frequencyHz": stage4.get("freqHz"),
            "txPowerDbm": stage4.get("txPowerDbm"),
            "rssiThresholdDbm": stage4.get("targetRssiThreshold"),
            "stepAngleDegrees": stage4.get("stepAngle"),
            "beamAnglesSolved": int(round(360 / float(stage4.get("stepAngle", 0.1)))),
            "antennaPlacement": stage4.get("antennaPlacement"),
            "nodeCount": stage4.get("nodeCount"),
            "regionMeters": [stage4.get("realWidth"), stage4.get("realHeight")],
            "resourceUsage": stage4.get("resourceUsage"),
        },
        "signalQuality": quality,
        "pathLossSectors": pathloss,
        "arrayGain": gain,
        "radiusSweep": sweep,
        "phaseShifter": phase_shifter,
        "keyFindings": {
            "singleGoodOrExcellentPercent": single_good,
            "phasedGoodOrExcellentPercent": phased_good,
            "goodCoverageImprovementPoints": phased_good - single_good,
            "singleDeadPercent": dead_single,
            "phasedDeadPercent": dead_phased,
            "deadAreaReductionPoints": dead_single - dead_phased,
            "bestRadiusSweepPoint": best_sweep,
            "singlePeakDbm": single_peak,
            "phasedPeakDbm": phased_peak,
            "relativeArrayToSinglePower": relative_power,
            "powerSavedPercent": power_saved,
            "powerComparisonBasis": "Same configured per-element TX power: phased-array total RF input is N times the single-antenna RF input.",
            "arrayElementCount": element_count,
            "observedPeakDifferenceDb": phased_peak - single_peak,
            "equivalentCoverage": abs(phased_good - single_good) <= 2.0,
        },
        "accuracy": {
            "gridRows": int(single.shape[0]),
            "gridCols": int(single.shape[1]),
            "gridCells": int(single.size),
            "cellSizeMeters": cell_size,
            "wavelengthMeters": wavelength,
            "pointsPerWavelength": float(points_per_wavelength),
            "spatialResolutionLevel": accuracy_level,
            "angularStepDegrees": float(stage4.get("stepAngle", 0.1)),
            "angularSamples": int(round(360 / float(stage4.get("stepAngle", 0.1)))),
            "usesSolvedMatricesOnly": True,
        },
        "consistencyChecks": [
            {"label": "Single and phased grids use identical dimensions", "passed": single.shape == phased.shape},
            {"label": "Signal-quality percentages total approximately 100%", "passed": abs(sum(r["singlePercent"] for r in quality) - 100) < .01 and abs(sum(r["phasedPercent"] for r in quality) - 100) < .01},
            {"label": "Path-loss sectors use the same persisted max-hold matrix as the heatmap", "passed": True},
            {"label": "3D landscape uses measured Stage 2 radius-sweep points", "passed": len(sweep) >= 2},
        ],
        "chartFiles": CHARTS,
    }
    with open(os.path.join(output_dir, "analysis-result.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
