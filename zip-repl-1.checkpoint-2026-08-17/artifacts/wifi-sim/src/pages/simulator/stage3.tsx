import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Database, ArrowLeft, ArrowRight, ChevronRight, CircleAlert as AlertCircle, Map, ChartBar as BarChart3, Radio, Download, Play, FileSliders as Sliders, FileText } from "lucide-react";
import { useCreateStage3Run } from "@workspace/api-client-react";

// Local type — Stage3Run is not in the generated schema (no GET endpoint)
interface Stage3Run {
  runId: string;
  createdAt: string;
  stage2RunId: string;
  executionTimeMs: number;
  finalNodes: [number, number][];
  nodeCount: number;
  maxNodes: number;
  coveragePercent: number;
  clusterCentroids: [number, number][];
  imageWidth: number;
  imageHeight: number;
  visualizationImageBase64: string;
}

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function Stage3() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const stage2RunId = params.get("stage2RunId") || "";
  const stage1RunId = params.get("runId") || "";
  const analysisRunId = params.get("analysisRunId") || "";
  const stage4RunId = params.get("stage4RunId") || "";
  const { toast } = useToast();

  const [maxNodes, setMaxNodes] = useState("5");
  const createStage3 = useCreateStage3Run();

  const handleRun = () => {
    const n = parseInt(maxNodes, 10);
    if (!stage2RunId) {
      toast({ title: "Missing Stage 2 run", description: "No Stage 2 run ID found.", variant: "destructive" });
      return;
    }
    if (!n || n < 1) {
      toast({ title: "Invalid budget", description: "Please enter a positive node count.", variant: "destructive" });
      return;
    }

    createStage3.mutate(
      { data: { stage2RunId, maxNodes: n } },
      {
        onSuccess: (r: Stage3Run) => {
          toast({
            title: "Budget Optimization Complete",
            description: `${r.nodeCount} nodes selected with ${r.coveragePercent.toFixed(1)}% coverage`,
          });
        },
        onError: (err) => {
          toast({
            title: "Budget Selection Failed",
            description: (err as any)?.data?.error || "An error occurred.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const result: Stage3Run | undefined = createStage3.data as Stage3Run | undefined;
  const isPending = createStage3.isPending;
  const isError = createStage3.isError;

  return (
    <div className="max-w-[1400px] mx-auto space-y-6 pb-20 animate-in fade-in duration-500">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-slate-500">
        <button
          onClick={() => setLocation(stage1RunId ? `/simulator/stage-1?runId=${stage1RunId}` : "/simulator/stage-1")}
          className="hover:text-primary transition-colors"
        >
          Phase 01
        </button>
        <ChevronRight size={14} className="text-border" />
        <button
          onClick={() => setLocation(stage2RunId ? `/simulator/stage-2?runId=${stage1RunId}` : "/simulator/stage-2")}
          className="hover:text-primary transition-colors"
        >
          Phase 02
        </button>
        <ChevronRight size={14} className="text-border" />
        <span className="text-accent font-bold">Phase 03: Budget Optimization</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-3">
            <span className="text-accent font-mono bg-accent/10 px-2 py-0.5 rounded text-sm border border-accent/20">Stage 03</span>
            Budget Optimization
          </h1>
          <p className="text-slate-400 mt-2 text-sm max-w-xl font-light">
            Select the best subset of Stage 2 nodes under a hardware budget constraint using backward-elimination. Stage 2 is never recomputed.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left: config + stats */}
        <div className="xl:col-span-4 space-y-4">
          {/* Budget input */}
          <div className="bg-card border border-border rounded p-5">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
              <Sliders size={14} className="text-accent" /> Hardware Budget
            </h3>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-[10px] uppercase tracking-widest text-slate-400">
                  Max Access Points
                </Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={maxNodes}
                    onChange={(e) => setMaxNodes(e.target.value)}
                    className="font-mono text-sm h-9 bg-background/50 border-border rounded-sm w-24"
                    disabled={isPending}
                  />
                  <Button
                    onClick={handleRun}
                    disabled={isPending || !stage2RunId}
                    className="flex-1 gap-2 bg-accent text-white hover:bg-accent/90 uppercase tracking-widest text-xs h-9 rounded disabled:opacity-50"
                  >
                    {isPending ? (
                      <span className="animate-pulse">Running…</span>
                    ) : (
                      <>
                        <Play size={12} fill="currentColor" /> Optimize
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-[10px] text-slate-600 font-mono">
                  Stage 2 placed {result ? result.clusterCentroids.length : "?"} clusters. Budget selects the best ≤N nodes.
                </p>
              </div>

              {!stage2RunId && (
                <p className="text-xs text-destructive font-mono">
                  No Stage 2 run linked. Return to Phase 02.
                </p>
              )}
            </div>
          </div>

          {/* Results stats */}
          {result && (
            <div className="bg-card border border-border rounded p-5">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
                <BarChart3 size={14} className="text-accent" /> Budget Results
              </h3>
              <div className="space-y-3">
                <StatRow label="Coverage" value={`${result.coveragePercent.toFixed(1)}%`} accent />
                <StatRow label="Nodes Selected" value={`${result.nodeCount} / ${result.maxNodes}`} />
                <StatRow label="Dead-Zone Clusters" value={String(result.clusterCentroids.length)} />
                <StatRow label="Selection Time" value={`${(result.executionTimeMs / 1000).toFixed(2)}s`} />
                <StatRow label="Image Size" value={`${result.imageWidth}×${result.imageHeight}`} />
              </div>
            </div>
          )}

          {/* Node positions */}
          {result && (
            <div className="bg-card border border-border rounded p-5">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 border-b border-border pb-2 flex items-center gap-2">
                <Radio size={14} className="text-accent" /> Selected Node Positions
              </h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {result.finalNodes.length === 0 ? (
                  <p className="text-slate-600 text-xs font-mono text-center py-4">No nodes selected</p>
                ) : (
                  result.finalNodes.map(([x, y]: [number, number], i: number) => (
                    <div key={i} className="flex justify-between items-center bg-background/50 px-2 py-1 rounded font-mono text-xs">
                      <span className="text-accent font-bold">AP{String(i + 1).padStart(2, "0")}</span>
                      <span className="text-slate-300">
                        ({Math.round(x)}, {Math.round(y)})
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {isError && !isPending && (
            <div className="bg-destructive/10 border border-destructive/30 rounded p-4 flex gap-3 relative overflow-hidden">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-destructive" />
              <AlertCircle className="text-destructive shrink-0" size={18} />
              <div>
                <p className="text-destructive font-bold text-xs uppercase tracking-widest mb-1">Failed</p>
                <p className="text-destructive/80 text-xs font-mono">
                  {(createStage3.error as any)?.data?.error || "Budget optimization failed."}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Right: visualization */}
        <div className="xl:col-span-8 bg-card border border-border rounded overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
              <Map size={14} className="text-accent" /> Budget-Constrained Placement
            </h3>
            {result && (
              <a
                href={result.visualizationImageBase64.startsWith("data:")
                  ? result.visualizationImageBase64
                  : `data:image/png;base64,${result.visualizationImageBase64}`}
                download={`stage3-${result.runId.slice(0, 8)}.png`}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-accent transition-colors font-mono uppercase tracking-widest"
              >
                <Download size={12} /> Export
              </a>
            )}
          </div>
          <div className="flex items-center justify-center min-h-[400px]">
            {!result && !isPending && (
              <div className="text-center space-y-3 py-12 text-slate-600">
                <Database size={40} className="mx-auto opacity-20" />
                <p className="text-xs font-mono uppercase tracking-widest">
                  Set a budget and run to see results
                </p>
              </div>
            )}
            {isPending && (
              <div className="text-center space-y-3 py-12">
                <div className="w-10 h-10 border-2 border-t-accent border-border rounded-full animate-spin mx-auto" />
                <p className="text-accent font-mono text-xs animate-pulse uppercase tracking-widest">
                  Selecting optimal subset…
                </p>
              </div>
            )}
            {result && (
              <div className="relative w-full">
                <img
                  src={result.visualizationImageBase64.startsWith("data:")
                    ? result.visualizationImageBase64
                    : `data:image/png;base64,${result.visualizationImageBase64}`}
                  alt="Stage 3 budget optimization visualization"
                  className="w-full h-auto object-contain"
                />
                {/* Legend */}
                <div className="absolute bottom-3 right-3 bg-background/80 border border-border rounded p-2 space-y-1.5 text-[10px] font-mono backdrop-blur-sm">
                  <LegendItem color="bg-yellow-400" label="Transmitter" />
                  <LegendItem color="bg-cyan-400" label="Selected Node" />
                  <LegendItem color="bg-orange-500" label="Dead-Zone Cluster" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-8 border-t border-border">
        <Button
          variant="outline"
          onClick={() => {
            const q = new URLSearchParams();
            if (stage2RunId) q.set("stage2RunId", stage2RunId);
            if (stage1RunId) q.set("runId", stage1RunId);
            if (analysisRunId) {
              q.set("analysisRunId", analysisRunId);
              if (stage4RunId) q.set("stage4RunId", stage4RunId);
              setLocation(`/simulator/stage-5?${q.toString()}`);
            } else {
              setLocation(`/simulator/stage-4?${q.toString()}`);
            }
          }}
          className="gap-2 border-border text-slate-300 hover:bg-secondary hover:text-white uppercase tracking-widest text-xs h-10 rounded"
        >
          <ArrowLeft size={16} /> {analysisRunId ? "Engineering Analysis" : "Phased Array"}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const q = new URLSearchParams();
            if (stage1RunId) q.set("runId", stage1RunId);
            if (analysisRunId) q.set("analysisRunId", analysisRunId);
            setLocation(q.toString() ? `/reports?${q.toString()}` : "/reports");
          }}
          className="gap-2 border-primary/40 text-primary hover:bg-primary/10 uppercase tracking-widest text-xs h-10 rounded"
        >
          <FileText size={16} /> Generate Report
        </Button>
      </div>
    </div>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-center bg-background/50 px-2 py-1.5 rounded">
      <span className="text-slate-500 uppercase tracking-widest text-[10px] font-mono">{label}</span>
      <span className={`font-mono text-xs font-bold ${accent ? "text-accent" : "text-slate-200"}`}>{value}</span>
    </div>
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
