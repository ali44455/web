import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  Cpu, ArrowRight, ArrowLeft, ChevronRight, Activity, AlertCircle,
  Radio, Target, Map, BarChart3, Download, Eye, EyeOff, Layers, Crop, CheckCircle2,
} from "lucide-react";
import { useCreateStage2Run, useGetStage1Run, getGetStage1RunQueryKey } from "@workspace/api-client-react";
import type { Stage2Run } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

// ROI type (mirrors HeatmapRoi in the API)
interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function Stage2() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const runId = params.get("runId");
  const { toast } = useToast();

  // ROI is now always confirmed server-side before Stage 2 runs.
  // It is loaded from roi.json in the Stage 1 run directory by the backend.

  const [showCandidates, setShowCandidates] = useState(false);
  const [showCentroids, setShowCentroids] = useState(true);

  const { data: stage1Data } = useGetStage1Run(runId || "", {
    query: { enabled: !!runId, queryKey: getGetStage1RunQueryKey(runId || "") },
  });

  const createStage2 = useCreateStage2Run();

  useEffect(() => {
    if (runId && !createStage2.isPending && !createStage2.data && !createStage2.isError) {
      const body: any = { stage1RunId: runId };
      createStage2.mutate(
        { data: body },
        {
          onSuccess: (result) => {
            toast({
              title: "Node Placement Complete",
              description: `${result.nodeCount} nodes placed with ${result.coveragePercent.toFixed(1)}% dead-zone coverage`,
            });
          },
          onError: (err) => {
            toast({
              title: "Optimization Failed",
              description: (err as any)?.data?.error || "Node placement failed",
              variant: "destructive",
            });
          },
        },
      );
    }
  }, [runId]);

  const result: Stage2Run | undefined = createStage2.data;
  const isPending = createStage2.isPending;
  const isError = createStage2.isError;

  // The ROI is always confirmed server-side before Stage 2 runs; it comes
  // back in the response payload (loaded from roi.json in the Stage 1 run dir).
  const activeRoi: Roi | null = (result as any)?.roi ?? null;

  const progressMessages = [
    "Extracting dead zones below threshold…",
    "Labelling connected components…",
    "Computing polar coordinates…",
    "Generating candidate locations within ROI…",
    "Building sector adjacency matrix…",
    "Running greedy placement (cluster-driven)…",
    "Applying redundancy pruning…",
    "Enforcing spatial diversity…",
    "Computing coverage statistics…",
    "Rendering visualization on Stage 1 heatmap…",
  ];
  const [progressIdx, setProgressIdx] = useState(0);
  useEffect(() => {
    if (!isPending) return;
    setProgressIdx(0);
    const iv = setInterval(() => setProgressIdx((p) => Math.min(p + 1, progressMessages.length - 1)), 8000);
    return () => clearInterval(iv);
  }, [isPending]);

  return (
    <div className="max-w-[1400px] mx-auto space-y-6 pb-20 animate-in fade-in duration-500">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-slate-500">
        <button
          onClick={() => setLocation(runId ? `/simulator/stage-1?runId=${runId}` : "/simulator/stage-1")}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          Phase 01
        </button>
        <ChevronRight size={14} className="text-border" />
        <span className="text-primary font-bold">Phase 02: Node Placement</span>
        <ChevronRight size={14} className="text-border" />
        <span className="opacity-50">Phase 03</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-3">
            <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded text-sm border border-primary/20">Stage 02</span>
            Node Placement & Optimization
          </h1>
          <p className="text-slate-400 mt-2 text-sm max-w-xl font-light">
            Dead-zone clustering, candidate generation within ROI, greedy cluster-driven placement, redundancy pruning, and spatial diversity enforcement.
          </p>
        </div>
      </div>

      {/* ROI status badge — ROI is always confirmed before Stage 2 runs */}
      <div className="flex items-center gap-2 text-[10px] font-mono bg-primary/10 border border-primary/30 rounded px-3 py-2 w-fit">
        <Crop size={11} className="text-primary" />
        <span className="text-primary font-bold uppercase tracking-widest">ROI Active</span>
        {activeRoi && (
          <span className="text-slate-400">
            ({activeRoi.x}, {activeRoi.y}) &nbsp;{activeRoi.width}×{activeRoi.height} px
          </span>
        )}
        <CheckCircle2 size={11} className="text-green-400 ml-1" />
      </div>

      {/* Loading state */}
      {isPending && (
        <div className="flex flex-col items-center justify-center gap-6 py-20 bg-card border border-border rounded">
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 border-2 border-primary/20 rounded-full" />
            <div className="absolute inset-0 border-2 border-t-primary rounded-full animate-spin" />
            <Cpu size={28} className="absolute inset-0 m-auto text-primary" />
          </div>
          <div className="text-center space-y-2">
            <p className="text-white font-bold uppercase tracking-widest text-sm">Running Optimizer</p>
            <p className="text-primary font-mono text-xs animate-pulse">{progressMessages[progressIdx]}</p>
            <p className="text-slate-600 text-xs">Greedy placement + pruning: 10–60 seconds typically</p>
          </div>
          <div className="flex gap-1">
            {progressMessages.map((_, i) => (
              <div
                key={i}
                className={`h-1 w-6 rounded-full transition-all duration-700 ${i <= progressIdx ? "bg-primary" : "bg-border"}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Error state */}
      {isError && !isPending && (
        <div className="bg-destructive/10 border border-destructive/30 rounded p-6 flex gap-4 max-w-3xl relative overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-destructive" />
          <AlertCircle className="text-destructive shrink-0" size={24} />
          <div className="space-y-2">
            <h3 className="text-destructive font-bold uppercase tracking-widest text-sm">Optimization Failed</h3>
            <p className="text-destructive/80 text-sm font-mono">
              {(createStage2.error as any)?.data?.error || "An error occurred during node placement."}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 text-xs mt-2"
              onClick={() => {
                if (!runId) return;
                createStage2.mutate({ data: { stage1RunId: runId } });
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Results */}
      {result && !isPending && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left: stats panel */}
          <div className="xl:col-span-4 space-y-4">
            {/* Coverage stat card */}
            <div className="bg-card border border-border rounded p-5">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
                <BarChart3 size={14} className="text-primary" /> Optimization Results
              </h3>
              <div className="space-y-3">
                <StatRow label="Dead-Zone Coverage" value={`${result.coveragePercent.toFixed(1)}%`} accent />
                <StatRow label="Final Nodes" value={String(result.nodeCount)} />
                <StatRow label="Dead-Zone Clusters" value={String(result.numClusters)} />
                <StatRow label="Execution Time" value={`${(result.executionTimeMs / 1000).toFixed(2)}s`} />
                <StatRow label="Exclusion Radius" value={`${result.bestExclusionRadius.toFixed(0)}px`} />
                <StatRow label="Coverage Radius" value={`${result.nodeCoverageRadius.toFixed(0)}px`} />
                <StatRow label="Image Size" value={`${result.imageWidth}×${result.imageHeight}`} />
              </div>
            </div>

            {/* ROI info */}
            {activeRoi && (
              <div className="bg-card border border-border rounded p-5">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
                  <Crop size={14} className="text-primary" /> Active ROI
                </h3>
                <div className="space-y-3">
                  <StatRow label="Origin" value={`(${activeRoi.x}, ${activeRoi.y})`} />
                  <StatRow label="Dimensions" value={`${activeRoi.width}×${activeRoi.height} px`} />
                  <p className="text-[10px] text-slate-600 font-mono leading-relaxed">
                    Nodes outside this region were excluded from placement. Stage 3 will reuse this ROI automatically.
                  </p>
                </div>
              </div>
            )}

            {/* Stage 1 context */}
            {stage1Data && (
              <div className="bg-card border border-border rounded p-5">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
                  <Activity size={14} className="text-primary" /> Stage 01 Context
                </h3>
                <div className="space-y-3">
                  <StatRow label="Grid" value={`${stage1Data.gridRows}×${stage1Data.gridCols}`} />
                  <StatRow label="Peak Signal" value={`${stage1Data.peakDb.toFixed(1)} dB`} />
                  <StatRow label="Cell Size" value={`${stage1Data.params.cellSizeMeters.toFixed(3)} m`} />
                  <StatRow label="Source Mode" value={stage1Data.sourceMode.toUpperCase()} />
                </div>
              </div>
            )}

            {/* Node coordinates */}
            <div className="bg-card border border-border rounded p-5">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
                <Radio size={14} className="text-primary" /> Final Node Positions
              </h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {result.finalNodes.length === 0 ? (
                  <p className="text-slate-600 text-xs font-mono text-center py-4">No nodes placed</p>
                ) : (
                  result.finalNodes.map(([x, y], i) => (
                    <div key={i} className="flex justify-between items-center bg-background/50 px-2 py-1 rounded font-mono text-xs">
                      <span className="text-primary font-bold">AP{String(i + 1).padStart(2, "0")}</span>
                      <span className="text-slate-300">
                        ({Math.round(x)}, {Math.round(y)})
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Visualization toggles */}
            <div className="bg-card border border-border rounded p-4">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                <Layers size={14} /> Display Options
              </h3>
              <div className="space-y-2">
                <ToggleRow
                  label="Cluster Centroids"
                  enabled={showCentroids}
                  onToggle={() => setShowCentroids((v) => !v)}
                />
                <ToggleRow
                  label="Candidate Locations"
                  enabled={showCandidates}
                  onToggle={() => setShowCandidates((v) => !v)}
                />
              </div>
            </div>
          </div>

          {/* Right: visualization */}
          <div className="xl:col-span-8 bg-card border border-border rounded overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
                <Map size={14} className="text-primary" /> Optimized Node Placement
                {activeRoi && (
                  <span className="text-[10px] font-mono text-primary/70 border border-primary/30 rounded px-1.5 py-0.5 bg-primary/5">
                    ROI
                  </span>
                )}
              </h3>
              <a
                href={result.visualizationImageBase64}
                download={`stage2-${result.runId.slice(0, 8)}.png`}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-primary transition-colors font-mono uppercase tracking-widest"
              >
                <Download size={12} /> Export
              </a>
            </div>
            <div className="relative">
              <img
                src={result.visualizationImageBase64}
                alt="Stage 2 node placement visualization"
                className="w-full h-auto object-contain"
              />
              {/* Legend */}
              <div className="absolute bottom-3 right-3 bg-background/80 border border-border rounded p-2 space-y-1.5 text-[10px] font-mono backdrop-blur-sm">
                <LegendItem color="bg-red-500" label="Transmitter (TX)" />
                <LegendItem color="bg-orange-500" label="Final Nodes" />
                <LegendItem color="bg-blue-500/60" label="Before Optimization" />
                <LegendItem color="bg-orange-500/50" label="Cluster Centroids" />
                {activeRoi && <LegendItem color="bg-yellow-400/60" label="ROI Boundary" />}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between pt-8 border-t border-border mt-4">
        <Button
          variant="outline"
          onClick={() => setLocation(runId ? `/simulator/stage-1?runId=${runId}` : "/simulator/stage-1")}
          className="gap-2 border-border text-slate-300 hover:bg-secondary hover:text-white uppercase tracking-widest text-xs h-10 rounded"
        >
          <ArrowLeft size={16} /> Stage 01
        </Button>
        <Button
          disabled={!result || isPending}
          onClick={() => {
            if (!result) return;
            const q = new URLSearchParams({
              stage2RunId: result.runId,
              ...(runId ? { runId } : {}),
            });
            setLocation(`/simulator/stage-4?${q.toString()}`);
          }}
          className="gap-2 uppercase tracking-widest text-xs h-10 rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Phased Array <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-center bg-background/50 px-2 py-1.5 rounded">
      <span className="text-slate-500 uppercase tracking-widest text-[10px] font-mono">{label}</span>
      <span className={`font-mono text-xs font-bold ${accent ? "text-primary" : "text-slate-200"}`}>{value}</span>
    </div>
  );
}

function ToggleRow({ label, enabled, onToggle }: { label: string; enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center justify-between w-full px-2 py-1.5 bg-background/50 rounded hover:bg-background transition-colors"
    >
      <span className="text-slate-400 uppercase tracking-widest text-[10px] font-mono">{label}</span>
      <span className={`text-[10px] font-mono font-bold ${enabled ? "text-primary" : "text-slate-600"}`}>
        {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
      </span>
    </button>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-3 h-3 rounded-full ${color}`} />
      <span className="text-slate-300">{label}</span>
    </div>
  );
}
