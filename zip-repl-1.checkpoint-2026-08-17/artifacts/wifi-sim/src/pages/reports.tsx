import { useEffect, useState } from "react";
import { useListStage1Runs, useGetStage1Run } from "@workspace/api-client-react";
import { Link, useSearch } from "wouter";
import { FileText, Download, Activity, Calendar, Zap, Clock, Maximize2, X, ChevronRight, Grid2x2 as Grid } from "lucide-react";
import { Button } from "@/components/ui/button";
import jsPDF from "jspdf";
import { motion, AnimatePresence } from "framer-motion";

export default function Reports() {
  const { data: runs, isLoading } = useListStage1Runs();
  const search = useSearch();
  const requestedRunId = new URLSearchParams(search).get("runId");
  const requestedAnalysisRunId = new URLSearchParams(search).get("analysisRunId");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  // Stage 3 links here with the Stage 1 run ID. Expand it automatically so
  // the report action is a real continuation of the workflow, not a dead end.
  useEffect(() => {
    if (requestedRunId && runs?.some((run) => run.runId === requestedRunId)) {
      setExpandedRunId(requestedRunId);
    }
  }, [requestedRunId, runs]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6 pb-20">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-3">
            <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded text-sm border border-primary/20">
              <FileText size={16} className="inline-block mr-1" /> Reports
            </span>
            Simulation History
          </h1>
          <p className="text-slate-400 mt-2 text-sm max-w-xl font-light">
            Review past FDFD simulation runs, view detailed coverage heatmaps, and export generated PDF reports.
          </p>
        </div>
        <Link href="/simulator">
          <Button variant="outline" className="h-9 text-[10px] uppercase tracking-widest font-mono">
            New Simulation
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-3 bg-card/30 rounded border border-border">
          <Activity size={32} className="animate-pulse opacity-50 text-primary" />
          <span className="text-xs font-mono uppercase tracking-widest">Loading history...</span>
        </div>
      ) : runs && runs.length > 0 ? (
        <div className="grid gap-4">
          {runs.map((run, i) => (
            <motion.div
              key={run.runId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="bg-card border border-border rounded overflow-hidden"
            >
              <div className="p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                    <Activity size={18} />
                  </div>
                  <div>
                    <div className="font-mono text-white font-bold text-sm tracking-widest uppercase">
                      Run {run.runId.substring(0, 8)}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                      <span className="flex items-center gap-1"><Calendar size={12} /> {new Date(run.createdAt).toLocaleDateString()}</span>
                      <span className="flex items-center gap-1"><Grid size={12} /> {run.gridRows}×{run.gridCols}</span>
                      <span className="flex items-center gap-1 text-accent"><Zap size={12} /> {run.peakDb.toFixed(1)} dB</span>
                      <span className="flex items-center gap-1"><Clock size={12} /> {(run.executionTimeMs / 1000).toFixed(2)}s</span>
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setExpandedRunId(expandedRunId === run.runId ? null : run.runId)}
                  className="w-full md:w-auto h-8 text-[10px] uppercase tracking-wider font-mono border-border bg-background hover:bg-secondary"
                >
                  {expandedRunId === run.runId ? "Hide Report" : "View Report"}
                </Button>
              </div>

              <AnimatePresence>
                {expandedRunId === run.runId && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t border-border bg-background/50 overflow-hidden"
                  >
                    <ReportDetail runId={run.runId} analysisRunId={run.runId === requestedRunId ? requestedAnalysisRunId : null} />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="bg-card border border-border rounded flex flex-col items-center justify-center p-16 text-center">
          <FileText size={48} className="text-slate-600 mb-4" />
          <h3 className="text-lg font-bold text-white uppercase tracking-widest mb-2">No simulations yet</h3>
          <p className="text-slate-400 max-w-md text-sm font-light mb-6">
            You haven't run any FDFD simulations in this session. Start a new simulation to generate reports.
          </p>
          <Link href="/simulator">
            <Button className="bg-primary text-white hover:bg-primary/90 rounded uppercase tracking-widest text-xs font-bold h-10 glow-primary transition-all hover:scale-[1.04] active:scale-[0.97]">
              Start Simulation
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function ReportDetail({ runId, analysisRunId }: { runId: string; analysisRunId: string | null }) {
  const { data: run, isLoading } = useGetStage1Run(runId);
  const [analysis, setAnalysis] = useState<any>(null);

  useEffect(() => {
    if (!analysisRunId) { setAnalysis(null); return; }
    fetch(`/api/stage5/runs/${encodeURIComponent(analysisRunId)}`)
      .then(async response => response.ok ? response.json() : null)
      .then(setAnalysis)
      .catch(() => setAnalysis(null));
  }, [analysisRunId]);

  const downloadPDF = () => {
    if (!run) return;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const margin = 14;

    pdf.setFillColor(13, 15, 18);
    pdf.rect(0, 0, W, H, "F");

    pdf.setFillColor(17, 24, 39);
    pdf.rect(0, 0, W, 22, "F");

    pdf.setTextColor(0, 163, 255);
    pdf.setFontSize(13);
    pdf.setFont("helvetica", "bold");
    pdf.text("SPARK SQUAD", margin, 10);
    pdf.setFontSize(7);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(148, 163, 184);
    pdf.text("RF COVERAGE SIMULATION REPORT", margin, 16);

    pdf.setFontSize(6.5);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`ID: ${run.runId}`, W - margin, 9, { align: "right" });
    pdf.text(`${new Date(run.createdAt).toLocaleString()}`, W - margin, 14, { align: "right" });

    pdf.setDrawColor(255, 184, 0);
    pdf.setLineWidth(0.5);
    pdf.line(margin, 23, W - margin, 23);

    const imgY = 28;
    const imgH = 110;
    if (run.heatmapImageBase64) {
      const src = run.heatmapImageBase64.startsWith("data:") ? run.heatmapImageBase64 : `data:image/png;base64,${run.heatmapImageBase64}`;
      pdf.addImage(src, "PNG", margin, imgY, W - margin * 2, imgH, undefined, "FAST");
    }

    const statsY = imgY + imgH + 8;
    const colW = (W - margin * 2) / 3;

    const sections: [string, [string, string][]][] = [
      ["MATRIX SPECS", [
        ["Resolution", `${run.params.cellSizeMeters.toFixed(3)} m`],
        ["Grid Size", `${run.gridRows} × ${run.gridCols}`],
        ["Coverage", `${((run.occupiedFraction || 0) * 100).toFixed(1)}%`],
      ]],
      ["PHYSICS PARAMS", [
        ["Refractive Idx", String(run.params.refractiveIndex)],
        ["Absorption", String(run.params.absorptionCoeff)],
        ["Proxy Freq", `${run.params.frequencyMHz} MHz`],
      ]],
      ["SOURCE DATA", [
        ["Amplitude", `${run.params.sourceValue} V/m`],
        ["Grid Position", `${run.sourceX}, ${run.sourceY}`],
        ["Peak Signal", `${run.peakDb.toFixed(1)} dB`],
      ]],
    ];

    sections.forEach(([heading, rows], ci) => {
      const x = margin + ci * colW;
      pdf.setFillColor(22, 30, 44);
      pdf.roundedRect(x, statsY, colW - 3, 52, 2, 2, "F");
      pdf.setFontSize(6.5);
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(0, 163, 255);
      pdf.text(heading, x + 4, statsY + 7);
      pdf.setDrawColor(30, 41, 59);
      pdf.setLineWidth(0.3);
      pdf.line(x + 4, statsY + 9, x + colW - 7, statsY + 9);
      pdf.setFont("helvetica", "normal");
      rows.forEach(([label, value], ri) => {
        const ry = statsY + 16 + ri * 10;
        pdf.setFontSize(6.5);
        pdf.setTextColor(100, 116, 139);
        pdf.text(label, x + 4, ry);
        pdf.setTextColor(226, 232, 240);
        pdf.text(value, x + colW - 7, ry, { align: "right" });
      });
    });

    const etY = statsY + 56;
    pdf.setFillColor(0, 163, 255, 12);
    pdf.roundedRect(margin, etY, W - margin * 2, 10, 2, 2, "F");
    pdf.setDrawColor(0, 163, 255, 40);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(margin, etY, W - margin * 2, 10, 2, 2, "S");
    pdf.setFontSize(7);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(0, 163, 255);
    pdf.text(`COMPUTE TIME: ${(run.executionTimeMs / 1000).toFixed(2)}s`, margin + 5, etY + 6.5);

    pdf.setFontSize(6);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(51, 65, 85);
    pdf.text(
      "Generated by CUFE Spark Squad RF Simulator • Finite-Difference Frequency-Domain (FDFD) Solver",
      W / 2, H - 8, { align: "center" }
    );
    pdf.setDrawColor(30, 41, 59);
    pdf.setLineWidth(0.3);
    pdf.line(margin, H - 12, W - margin, H - 12);

    if (analysis?.chartImages) {
      const titles: Record<string, string> = {
        beamSweeping: "Beam Sweeping - Solved Fields",
        pathLoss: "Total Path Loss Across Sectors",
        arrayGain: "Phased Array Gain Trade-off",
        signalQuality: "Signal Quality Distribution",
        tradeoff3d: "Unified 3D Node Trade-off",
        phaseDelay: "Phase Shifter Delay Profile",
        phaseTolerance: "Phase Shifter Tolerance Impact",
      };
      Object.entries(analysis.chartImages).forEach(([key, image]) => {
        pdf.addPage("a4", "landscape");
        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();
        pdf.setFillColor(13, 15, 18);
        pdf.rect(0, 0, pageW, pageH, "F");
        pdf.setTextColor(0, 163, 255);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(13);
        pdf.text(titles[key] || key, 14, 13);
        pdf.addImage(image as string, "PNG", 14, 20, pageW - 28, pageH - 30, undefined, "FAST");
      });
    }

    pdf.save(`SparkSquad_Report_${run.runId.substring(0, 8)}.pdf`);
  };

  if (isLoading || !run) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Activity size={24} className="text-primary animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6">
      <div className="flex flex-col lg:flex-row gap-6">
      <div className="w-full lg:w-1/3 space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold uppercase tracking-widest text-slate-300">Simulation Data</h4>
          <Button
            size="sm"
            onClick={downloadPDF}
            className="h-8 text-[10px] uppercase tracking-wider font-mono border-border bg-card hover:bg-secondary text-primary hover:text-primary transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Download size={14} className="mr-1.5" /> Download PDF
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Resolution" value={`${run.params.cellSizeMeters.toFixed(3)}m`} />
          <Stat label="Coverage" value={`${((run.occupiedFraction || 0) * 100).toFixed(1)}%`} />
          <Stat label="Freq" value={`${run.params.frequencyMHz} MHz`} />
          <Stat label="Absorption" value={String(run.params.absorptionCoeff)} />
        </div>
      </div>
      <div className="flex-1 rounded border border-border bg-black relative flex items-center justify-center p-2 min-h-[300px]">
        {run.heatmapImageBase64 ? (
          <img
            src={run.heatmapImageBase64.startsWith('data:') ? run.heatmapImageBase64 : `data:image/png;base64,${run.heatmapImageBase64}`}
            className="max-h-[300px] object-contain"
            alt="Heatmap"
          />
        ) : (
          <span className="text-xs text-slate-500 font-mono">No heatmap image</span>
        )}
      </div>
      </div>
      {analysis?.chartImages && (
        <div className="border-t border-border pt-5">
          <h4 className="text-xs font-bold uppercase tracking-widest text-primary mb-3">Integrated Engineering Analysis</h4>
          <div className="grid md:grid-cols-2 gap-3">
            {Object.entries(analysis.chartImages).map(([key, image]) => (
              <div key={key} className="bg-white border border-border rounded overflow-hidden">
                <img src={image as string} alt={key} className="w-full h-auto" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string, value: string | number }) {
  return (
    <div className="bg-background border border-border rounded p-2 flex flex-col gap-1">
      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{label}</span>
      <span className="font-mono text-xs text-slate-200">{value}</span>
    </div>
  );
}
