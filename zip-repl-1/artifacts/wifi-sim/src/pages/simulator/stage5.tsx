import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { ArrowLeft, ArrowRight, BarChart3, CheckCircle2, Download, Loader2, Rotate3D, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

type Analysis = {
  runId: string;
  stage1RunId: string;
  stage2RunId: string;
  stage4RunId: string;
  executionTimeMs: number;
  inputSummary: any;
  signalQuality: Array<{ label: string; singlePercent: number; phasedPercent: number }>;
  pathLossSectors: Array<{ angle: number; distanceMeters: number[]; singleDbm: number[]; phasedDbm: number[] }>;
  arrayGain: Array<{ elements: number; totalPeakGainDb: number; operatingPoint: boolean }>;
  radiusSweep: Array<{ radius: number; requiredNodes: number; coveragePercent: number }>;
  phaseShifter: {
    wavelengthMeters: number;
    elementSpacingMeters: number;
    carrierPeriodPs: number;
    maxIdealDelayPs: number;
    delayTable: Array<{ angleDegrees: number; requiredPhaseDegrees: number; idealDelayPs: number; pathDifferenceCm: number }>;
    pdfReference: { timingErrorPs: number; phaseErrorAt2_4GHzDegrees: number; phaseErrorAtSelectedFrequencyDegrees: number };
  };
  keyFindings: any;
  accuracy: { gridRows: number; gridCols: number; gridCells: number; cellSizeMeters: number; wavelengthMeters: number; pointsPerWavelength: number; spatialResolutionLevel: string; angularStepDegrees: number; angularSamples: number; usesSolvedMatricesOnly: boolean };
  consistencyChecks: Array<{ label: string; passed: boolean }>;
  chartImages: Record<string, string>;
};

const graphCopy: Record<string, { title: string; text: string }> = {
  beamSweeping: {
    title: "Beam Sweeping — Solved Field Snapshots",
    text: "Four real FDFD field matrices captured during the 360° phased-array scan. Obstacles, diffraction and attenuation come from the uploaded map and previous RF inputs.",
  },
  pathLoss: {
    title: "Total Path Loss Across Sectors",
    text: "Effective path loss (configured per-element TX power minus solved RSSI) at 15°, 40°, 60° and 75°. Orange is the Stage 1 single antenna; blue is the exact Stage 4 max-hold phased-array matrix. Sudden rises identify obstacle crossings.",
  },
  arrayGain: {
    title: "Phased Array Gain Trade-off",
    text: "Analytic array gain versus element count using 2.15 dBi element gain. The star marks the simulator's five-element operating point.",
  },
  signalQuality: {
    title: "Signal Quality Distribution",
    text: "Percentage of non-building area in Dead, Poor, Good and Excellent RSSI buckets. Values are calculated directly from the aligned Stage 1 and Stage 4 dB grids.",
  },
  tradeoff3d: {
    title: "Unified 3D Trade-off Landscape",
    text: "Measured Stage 2 radius sweep: exclusion radius (hardware placement), required candidates (cost), and dead-zone cluster coverage. Every marker is an optimizer measurement.",
  },
  phaseDelay: {
    title: "Phase Shifter Delay and Phase Profile",
    text: "The ideal adjacent-element delay Δt = d·sin(θ)/c and phase shift Δφ = 180°·sin(θ), using the previous stage's carrier frequency and half-wavelength element spacing.",
  },
  phaseTolerance: {
    title: "Phase Shifter Tolerance Impact",
    text: "Timing jitter is converted to RMS phase mismatch and then to expected coherent power for the finite five-element array. The second curve translates power loss into relative free-space coverage radius.",
  },
};

const chartOrder = ["pathLoss", "signalQuality", "beamSweeping", "tradeoff3d", "arrayGain", "phaseDelay", "phaseTolerance"];

export default function Stage5() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const query = new URLSearchParams(search);
  const stage4RunId = query.get("stage4RunId") ?? "";
  const stage2RunId = query.get("stage2RunId") ?? "";
  const stage1RunId = query.get("runId") ?? "";
  const analysisRunId = query.get("analysisRunId") ?? "";
  const started = useRef(false);
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const load = async () => {
      try {
        const response = analysisRunId
          ? await fetch(`/api/stage5/runs/${encodeURIComponent(analysisRunId)}`)
          : await fetch("/api/stage5/runs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stage4RunId }),
            });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Engineering analysis failed");
        setData(body);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Engineering analysis failed");
      }
    };
    if (analysisRunId || stage4RunId) load();
    else setError("A completed Phased Array run is required. Return to Stage 4 and run the simulation.");
  }, [analysisRunId, stage4RunId]);

  const linkedStage1 = data?.stage1RunId || stage1RunId;
  const linkedStage2 = data?.stage2RunId || stage2RunId;
  const stageQuery = new URLSearchParams();
  if (linkedStage1) stageQuery.set("runId", linkedStage1);
  if (linkedStage2) stageQuery.set("stage2RunId", linkedStage2);
  if (data?.runId) stageQuery.set("analysisRunId", data.runId);
  if (data?.stage4RunId || stage4RunId) stageQuery.set("stage4RunId", data?.stage4RunId || stage4RunId);

  if (error) return (
    <div className="max-w-3xl mx-auto bg-destructive/10 border border-destructive/40 rounded p-8 text-center space-y-4">
      <h1 className="text-xl font-bold text-destructive">Engineering Analysis Failed</h1>
      <p className="text-sm text-slate-300 font-mono">{error}</p>
      <Button variant="outline" onClick={() => setLocation(`/simulator/stage-4?${stageQuery}`)}><ArrowLeft size={15} /> Return to Phased Array</Button>
    </div>
  );

  if (!data) return (
    <div className="min-h-[520px] flex flex-col items-center justify-center gap-4 bg-card border border-border rounded">
      <Loader2 size={42} className="animate-spin text-primary" />
      <h1 className="font-bold uppercase tracking-widest">Generating Engineering Graphs</h1>
      <p className="text-sm text-slate-500 font-mono">Reading solved outputs from Heatmap, Node Placement and Phased Array…</p>
    </div>
  );

  const findings = data.keyFindings;
  return (
    <div className="max-w-[1400px] mx-auto space-y-7 pb-20">
      <div className="border-b border-border pb-5 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="text-xs text-primary font-mono uppercase tracking-widest mb-2">Stage 05 • Post-Array Analysis</div>
          <h1 className="text-2xl font-bold uppercase tracking-widest flex items-center gap-3"><BarChart3 className="text-primary" /> Engineering Analysis</h1>
          <p className="text-sm text-slate-400 mt-2 max-w-3xl">All charts use the previous stages' persisted map, transmitter, nodes, RF parameters, solved single-antenna grid and 360° phased-array output.</p>
        </div>
        <a href={`/api/stage5/runs/${data.runId}/export`} download>
          <Button variant="outline" className="gap-2"><Download size={15} /> Export Numerical Analysis</Button>
        </a>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <Metric label="Beam angles" value={String(data.inputSummary.beamAnglesSolved)} />
        <Metric label="Angular step" value={`${data.inputSummary.stepAngleDegrees}°`} />
        <Metric label="Frequency" value={`${(data.inputSummary.frequencyHz / 1e6).toFixed(1)} MHz`} />
        <Metric label="TX power" value={`${data.inputSummary.txPowerDbm} dBm`} />
        <Metric label="Nodes analyzed" value={String(data.inputSummary.nodeCount)} />
      </div>

      <div className="grid md:grid-cols-4 gap-4">
        <Finding label="Good + Excellent coverage" value={`${findings.phasedGoodOrExcellentPercent.toFixed(1)}%`} detail={`${findings.goodCoverageImprovementPoints >= 0 ? "+" : ""}${findings.goodCoverageImprovementPoints.toFixed(1)} percentage points vs single`} />
        <Finding label="Dead-area reduction" value={`${findings.deadAreaReductionPoints.toFixed(1)} pp`} detail={`${findings.singleDeadPercent.toFixed(1)}% → ${findings.phasedDeadPercent.toFixed(1)}%`} />
        <Finding label="Analysis time" value={`${(data.executionTimeMs / 1000).toFixed(2)} s`} detail="No FDFD recomputation" />
        <Finding label="RF input power" value={findings.powerSavedPercent >= 0 ? `${findings.powerSavedPercent.toFixed(1)}% saved` : `${Math.abs(findings.powerSavedPercent).toFixed(1)}% more`} detail={findings.powerComparisonBasis || "Calculated from configured RF inputs"} />
      </div>

      <section className="bg-card border border-border rounded p-5">
        <h2 className="font-bold uppercase tracking-wider mb-4">Numerical Accuracy and Resource Verification</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric label="Solved grid" value={`${data.accuracy.gridCols} × ${data.accuracy.gridRows}`} />
          <Metric label="Grid cells" value={data.accuracy.gridCells.toLocaleString()} />
          <Metric label="Points / wavelength" value={data.accuracy.pointsPerWavelength.toFixed(2)} />
          <Metric label="Spatial resolution" value={data.accuracy.spatialResolutionLevel.toUpperCase()} />
          <Metric label="Cell size" value={`${data.accuracy.cellSizeMeters.toFixed(4)} m`} />
          <Metric label="Wavelength" value={`${data.accuracy.wavelengthMeters.toFixed(4)} m`} />
          <Metric label="Angular samples" value={String(data.accuracy.angularSamples)} />
          <Metric label="Angular precision" value={`${data.accuracy.angularStepDegrees}°`} />
          <Metric label="Logical CPU cores" value={String(data.inputSummary.resourceUsage?.logicalCpuCores ?? "Recorded by solver")} />
          <Metric label="Numeric threads" value={String(data.inputSummary.resourceUsage?.numericThreads ?? "Auto")} />
          <Metric label="Multi-RHS batch" value={String(data.inputSummary.resourceUsage?.multiRhsBatchSize ?? "Auto")} />
          <Metric label="Full-resolution cells" value={Number(data.inputSummary.resourceUsage?.fullResolutionGridCells ?? data.accuracy.gridCells).toLocaleString()} />
        </div>
        <p className={`text-xs mt-4 ${data.accuracy.spatialResolutionLevel === "under-resolved" ? "text-amber-400" : "text-green-400"}`}>
          {data.accuracy.spatialResolutionLevel === "high" ? "High spatial fidelity: at least 10 grid points per wavelength." : data.accuracy.spatialResolutionLevel === "acceptable" ? "Acceptable spatial fidelity: 6–10 grid points per wavelength." : "Warning: fewer than 6 grid points per wavelength. Reduce carrier frequency or cell size before treating the result as high-accuracy FDFD data."}
        </p>
      </section>

      {chartOrder.filter(key => data.chartImages[key]).map(key => (
        <section key={key} className="bg-card border border-border rounded overflow-hidden">
          <div className="p-5 border-b border-border">
            <h2 className="font-bold uppercase tracking-wider text-slate-100">{graphCopy[key]?.title || key}</h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">{graphCopy[key]?.text}</p>
          </div>
          <div className="bg-white p-2 flex justify-center"><img src={data.chartImages[key]} alt={graphCopy[key]?.title || key} className="max-h-[760px] w-auto max-w-full object-contain" /></div>
        </section>
      ))}

      <section className="grid xl:grid-cols-2 gap-5">
        <div className="bg-card border border-border rounded p-5">
          <h2 className="font-bold uppercase tracking-wider mb-4">Signal Quality — Exact Percentages</h2>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest text-slate-500"><tr><th className="text-left p-2">Bucket</th><th className="text-right p-2">Single</th><th className="text-right p-2">Phased</th><th className="text-right p-2">Change</th></tr></thead>
            <tbody>{data.signalQuality.map(row => <tr key={row.label} className="border-t border-border font-mono"><td className="p-2">{row.label}</td><td className="text-right p-2 text-orange-400">{row.singlePercent.toFixed(2)}%</td><td className="text-right p-2 text-primary">{row.phasedPercent.toFixed(2)}%</td><td className="text-right p-2">{(row.phasedPercent-row.singlePercent).toFixed(2)} pp</td></tr>)}</tbody>
          </table></div>
        </div>
        <div className="bg-card border border-border rounded p-5">
          <h2 className="font-bold uppercase tracking-wider mb-4 flex items-center gap-2"><Rotate3D size={17} className="text-primary" /> Radius Sweep Measurements</h2>
          {data.radiusSweep.length ? <div className="max-h-72 overflow-auto"><table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest text-slate-500 sticky top-0 bg-card"><tr><th className="text-left p-2">Radius</th><th className="text-right p-2">Required candidates</th><th className="text-right p-2">Coverage</th></tr></thead>
            <tbody>{data.radiusSweep.map(row => <tr key={row.radius} className="border-t border-border font-mono"><td className="p-2">{row.radius.toFixed(0)} cells</td><td className="text-right p-2">{row.requiredNodes}</td><td className="text-right p-2 text-primary">{row.coveragePercent.toFixed(1)}%</td></tr>)}</tbody>
          </table></div> : <p className="text-sm text-slate-500">No radius sweep was retained by this older Stage 2 run. Rerun Node Placement for the 3D measurements.</p>}
        </div>
      </section>

      <section className="grid xl:grid-cols-2 gap-5">
        <div className="bg-card border border-border rounded p-5">
          <h2 className="font-bold uppercase tracking-wider mb-4">Inter-element Delay Profile</h2>
          <div className="grid grid-cols-2 gap-2 mb-4">
            <Metric label="Wavelength" value={`${(data.phaseShifter.wavelengthMeters * 100).toFixed(3)} cm`} />
            <Metric label="Element spacing (λ/2)" value={`${(data.phaseShifter.elementSpacingMeters * 100).toFixed(3)} cm`} />
            <Metric label="Carrier period" value={`${data.phaseShifter.carrierPeriodPs.toFixed(2)} ps`} />
            <Metric label="Maximum delay" value={`${data.phaseShifter.maxIdealDelayPs.toFixed(2)} ps`} />
          </div>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest text-slate-500"><tr><th className="text-left p-2">Angle</th><th className="text-right p-2">Phase</th><th className="text-right p-2">Delay</th><th className="text-right p-2">Path difference</th></tr></thead>
            <tbody>{data.phaseShifter.delayTable.map(row => <tr key={row.angleDegrees} className="border-t border-border font-mono"><td className="p-2">{row.angleDegrees}°</td><td className="text-right p-2">{row.requiredPhaseDegrees.toFixed(1)}°</td><td className="text-right p-2 text-primary">{row.idealDelayPs.toFixed(2)} ps</td><td className="text-right p-2">{row.pathDifferenceCm.toFixed(3)} cm</td></tr>)}</tbody>
          </table></div>
        </div>
        <div className="bg-card border border-border rounded p-5">
          <h2 className="font-bold uppercase tracking-wider mb-4">PDF Reference Validation</h2>
          <p className="text-sm text-slate-400 leading-relaxed">The phase-shifter paper states that 23.1 ps of timing error produces approximately 20° phase mismatch at 2.4 GHz. The integrated calculation produces <span className="font-mono text-primary">{data.phaseShifter.pdfReference.phaseErrorAt2_4GHzDegrees.toFixed(2)}°</span>.</p>
          <p className="text-sm text-slate-400 leading-relaxed mt-3">At this simulation's selected frequency, the same 23.1 ps error produces <span className="font-mono text-primary">{data.phaseShifter.pdfReference.phaseErrorAtSelectedFrequencyDegrees.toFixed(3)}°</span>. This difference is expected because phase sensitivity scales linearly with carrier frequency.</p>
          <div className="mt-5 border-t border-border pt-4 text-xs text-slate-500 space-y-2">
            <p>Hardware effects represented: phase noise / jitter, finite-array coherent gain reduction, and effective coverage-radius reduction.</p>
            <p>Manufacturing tolerance, thermal drift, quantization and mutual coupling are identified as physical causes; they are not invented as solved map data unless measured hardware values are supplied.</p>
          </div>
        </div>
      </section>

      <section className="bg-card border border-border rounded p-5">
        <h2 className="font-bold uppercase tracking-wider mb-4 flex items-center gap-2"><ShieldCheck size={17} className="text-green-400" /> Cross-Graph Consistency</h2>
        <div className="grid md:grid-cols-2 gap-3">{data.consistencyChecks.map(check => <div key={check.label} className="flex items-center gap-3 bg-background/50 rounded p-3"><CheckCircle2 size={17} className={check.passed ? "text-green-400" : "text-amber-400"} /><span className="text-xs text-slate-300">{check.label}</span></div>)}</div>
      </section>

      <div className="flex justify-between pt-6 border-t border-border">
        <Button variant="outline" onClick={() => setLocation(`/simulator/stage-4?${stageQuery}`)} className="gap-2"><ArrowLeft size={16} /> Phased Array</Button>
        <Button onClick={() => setLocation(`/simulator/stage-3?${stageQuery}`)} className="gap-2">Budget Optimization <ArrowRight size={16} /></Button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-card border border-border rounded p-4"><div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div><div className="font-mono font-bold text-primary mt-1">{value}</div></div>;
}

function Finding({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="bg-primary/5 border border-primary/20 rounded p-5"><div className="text-[10px] uppercase tracking-widest text-slate-400">{label}</div><div className="text-2xl font-mono font-bold text-primary my-2">{value}</div><div className="text-xs text-slate-500">{detail}</div></div>;
}
