/**
 * Stage 4 — Phased Array Beam Steering
 * Position in pipeline: Stage 2 (Node Placement) → ★ Stage 4 ★ → Stage 5 (Analysis)
 *
 * Shows a real-time animated video of the phased array beam steering across
 * all iterations, then a full image gallery of every output frame with download.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { Zap, ArrowLeft, ArrowRight, ChevronRight, CircleAlert as AlertCircle, Radio, Activity, Play, Pause, RotateCcw, Download, Layers, Info, Antenna, Maximize2, X, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SimFrame {
  frameIdx: number;
  frameType: "node_placement" | "baseline" | "scan" | "steering" | "final_labeled" | "max_hold";
  imageBase64: string;
  metadata: Record<string, unknown>;
}

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

type SimStatus = "idle" | "creating" | "precomputing" | "streaming" | "done" | "error";

interface Cfg {
  txPowerDbm: number;
  targetRssiThreshold: number;
  nIterations: number;
  stepAngle: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const FRAME_TYPE_LABEL: Record<SimFrame["frameType"], string> = {
  node_placement: "Node Placement",
  baseline:       "Single-Antenna Baseline",
  scan:           "Full 360° Scan",
  steering:       "Beam Steering",
  final_labeled:  "Final Beam (labeled)",
  max_hold:       "Max-Hold Coverage (360°)",
};

const SPEEDS = [
  { label: "0.5×", ms: 900 },
  { label: "1×",   ms: 500 },
  { label: "2×",   ms: 250 },
  { label: "4×",   ms: 120 },
];

// The MP4 and PNG sequence contain every frame. Keep the browser gallery
// bounded so 3,600 base64 images do not make React/Chromium run out of RAM.
const MAX_LIVE_GALLERY_FRAMES = 720;

// ── Helpers ────────────────────────────────────────────────────────────────────

function download(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function imageSrc(value: string) {
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
}

function frameFilename(f: SimFrame) {
  if (f.frameType === "scan") {
    return `phased-array-frame-${String(f.frameIdx).padStart(4, "0")}-${Number(f.metadata.angle ?? 0).toFixed(1)}deg.png`;
  }
  if (f.frameType === "steering") {
    return `phased-array-frame-${String(f.frameIdx).padStart(3, "0")}-${Number(f.metadata.angle ?? 0).toFixed(0)}deg.png`;
  }
  return `phased-array-${f.frameType}-${String(f.frameIdx).padStart(3, "0")}.png`;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function Stage4() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const urlParams    = new URLSearchParams(searchString);
  const stage2RunId  = urlParams.get("stage2RunId") ?? "";
  const stage1RunId  = urlParams.get("runId") ?? "";
  const { toast }    = useToast();

  // ── Config ─────────────────────────────────────────────────────────────────
  const [cfg, setCfg] = useState<Cfg>({ txPowerDbm: 19, targetRssiThreshold: -80, nIterations: 10, stepAngle: 5 });

  // ── Simulation state ───────────────────────────────────────────────────────
  const [status,       setStatus]       = useState<SimStatus>("idle");
  const [errorMsg,     setErrorMsg]     = useState("");
  const [frames,       setFrames]       = useState<SimFrame[]>([]);
  const [initInfo,     setInitInfo]     = useState<{ nodeCount: number; weakNodeCount: number; totalAngles: number } | null>(null);
  const [precomputePct, setPrecomputePct] = useState(0);
  const [doneInfo,     setDoneInfo]     = useState<SseEvent | null>(null);
  const [videoUrl,     setVideoUrl]     = useState<string | null>(null);
  const [stage4RunId,  setStage4RunId]  = useState<string | null>(null);
  const [exporting,    setExporting]    = useState(false);

  // ── Video player state ─────────────────────────────────────────────────────
  const [playhead,   setPlayhead]   = useState(0);   // current visible frame index
  const [playing,    setPlaying]    = useState(false);
  const [speedIdx,   setSpeedIdx]   = useState(1);   // index into SPEEDS
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null); // gallery fullscreen

  const playerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef          = useRef<EventSource | null>(null);
  const framesRef      = useRef<SimFrame[]>([]); // mirrors state for callbacks

  // Keep framesRef in sync
  useEffect(() => { framesRef.current = frames; }, [frames]);

  // ── Playback tick ──────────────────────────────────────────────────────────
  const stopTimer = useCallback(() => {
    if (playerTimerRef.current) { clearTimeout(playerTimerRef.current); playerTimerRef.current = null; }
  }, []);

  const tick = useCallback(() => {
    stopTimer();
    setPlayhead((prev) => {
      const next = prev + 1;
      if (next >= framesRef.current.length) {
        setPlaying(false);
        return framesRef.current.length - 1;
      }
      playerTimerRef.current = setTimeout(tick, SPEEDS[speedIdx].ms);
      return next;
    });
  }, [speedIdx, stopTimer]);

  useEffect(() => {
    if (playing && frames.length > 0) {
      stopTimer();
      playerTimerRef.current = setTimeout(tick, SPEEDS[speedIdx].ms);
    } else {
      stopTimer();
    }
    return stopTimer;
  }, [playing, speedIdx, frames.length, tick, stopTimer]);

  // While streaming — auto-advance playhead to newest frame
  useEffect(() => {
    if (status === "streaming") {
      setPlayhead(frames.length - 1);
    }
  }, [frames.length, status]);

  // ── Start simulation ───────────────────────────────────────────────────────
  const startRun = useCallback(async () => {
    if (!stage2RunId) return;
    esRef.current?.close();
    stopTimer();
    setStatus("creating");
    setFrames([]);
    framesRef.current = [];
    setPlayhead(0);
    setPlaying(false);
    setPrecomputePct(0);
    setInitInfo(null);
    setDoneInfo(null);
    setVideoUrl(null);
    setStage4RunId(null);
    setExporting(false);
    setErrorMsg("");

    try {
      const res = await fetch("/api/stage4/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage2RunId,
          txPowerDbm:          cfg.txPowerDbm,
          targetRssiThreshold: cfg.targetRssiThreshold,
          nIterations:         cfg.nIterations,
          stepAngle:            cfg.stepAngle,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to create run" }));
        throw new Error(err.error ?? "Failed to create Stage 4 run");
      }
      const { runId: s4Id } = await res.json() as { runId: string };
      setStage4RunId(s4Id);

      setStatus("precomputing");
      const es = new EventSource(`/api/stage4/runs/${s4Id}/stream`);
      esRef.current = es;

      es.onmessage = (e) => {
        let obj: SseEvent;
        try { obj = JSON.parse(e.data); } catch { return; }

        if (obj.type === "init") {
          setInitInfo(obj as any);
        } else if (obj.type === "precompute_progress") {
          const done  = obj.done as number;
          const total = obj.total as number;
          setPrecomputePct(Math.round((done / total) * 100));
        } else if (obj.type === "precompute_done") {
          setStatus("streaming");
        } else if (obj.type === "frame") {
          const f: SimFrame = {
            frameIdx:    obj.frameIdx as number,
            frameType:   obj.frameType as SimFrame["frameType"],
            imageBase64: imageSrc(obj.imageBase64 as string),
            metadata:    (obj.metadata ?? {}) as Record<string, unknown>,
          };
          setFrames((prev) => {
            const next = [...prev, f];
            return next.length > MAX_LIVE_GALLERY_FRAMES
              ? next.slice(next.length - MAX_LIVE_GALLERY_FRAMES)
              : next;
          });
        } else if (obj.type === "done" || obj.type === "already_done") {
          setDoneInfo(obj);
          setVideoUrl(`/api/stage4/runs/${s4Id}/video`);
          setStatus("done");
          setPlaying(false);
          es.close();
          toast({ title: "Simulation Complete", description: `${obj.totalFrames ?? ""} frames rendered` });
        } else if (obj.type === "error") {
          setErrorMsg((obj.message as string) ?? "Unknown error");
          setStatus("error");
          es.close();
        }
      };

      es.onerror = () => {
        if (status !== "done") {
          setErrorMsg("Stream connection lost");
          setStatus("error");
        }
        es.close();
      };
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to start simulation");
      setStatus("error");
    }
  }, [stage2RunId, cfg, stopTimer]);

  const exportResults = useCallback(async () => {
    if (!stage4RunId) return;
    setExporting(true);
    try {
      const response = await fetch(`/api/stage4/runs/${stage4RunId}/export`);
      if (!response.ok) throw new Error("Export is not ready");
      const payload = await response.json() as Record<string, unknown> & {
        maxHoldImageBase64?: string;
      };
      const metadata = { ...payload };
      delete metadata.maxHoldImageBase64;
      const escapedJson = JSON.stringify(metadata, null, 2)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const image = payload.maxHoldImageBase64 ? imageSrc(payload.maxHoldImageBase64) : "";
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Phased Array Heatmap Export</title>
        <style>body{font-family:Arial,sans-serif;background:#10131a;color:#e5e7eb;margin:32px}h1{color:#18a8ff}img{max-width:100%;background:#1e1e2e}pre{background:#171b24;padding:20px;overflow:auto;border-radius:6px}</style>
        </head><body><h1>Phased Array Heatmap &amp; Antenna Placement</h1><img src="${image}" alt="Max-hold coverage heatmap"><h2>Solver and placement metadata</h2><pre>${escapedJson}</pre></body></html>`;
      const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      download(blobUrl, `phased-array-heatmap-placement-${stage4RunId.slice(0, 8)}.html`);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      toast({ title: "Export Ready", description: "Self-contained heatmap and antenna placement report downloaded." });
    } catch (err) {
      toast({ title: "Export Failed", description: err instanceof Error ? err.message : "Could not create export", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, [stage4RunId, toast]);

  // Cleanup
  useEffect(() => () => { esRef.current?.close(); stopTimer(); }, [stopTimer]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const currentFrame   = frames[playhead] ?? null;
  const maxHoldFrame   = [...frames].reverse().find((f) => f.frameType === "max_hold") ?? null;
  const isRunning      = status === "creating" || status === "precomputing" || status === "streaming";
  const canPlay        = status === "done" && frames.length > 1;

  const buildNavQuery = (extra?: Record<string, string>) => {
    const q = new URLSearchParams();
    if (stage2RunId) q.set("stage2RunId", stage2RunId);
    if (stage1RunId) q.set("runId", stage1RunId);
    if (extra) Object.entries(extra).forEach(([k, v]) => q.set(k, v));
    return q.toString();
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1400px] mx-auto space-y-8 pb-20 animate-in fade-in duration-500">

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-slate-500">
        <button onClick={() => setLocation(`/simulator/stage-2?runId=${stage1RunId}`)}
          className="hover:text-slate-300 transition-colors">Phase 02: Node Placement</button>
        <ChevronRight size={12} className="text-border" />
        <span className="text-primary font-bold">Phase 03: Phased Array</span>
        <ChevronRight size={12} className="text-border" />
        <span className="text-slate-500">Phase 04: Engineering Analysis</span>
      </div>

      {/* Header */}
      <div className="border-b border-border pb-5">
        <h1 className="text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-3">
          <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded text-sm border border-primary/20">Phase 03</span>
          Phased Array Beam Steering
        </h1>
        <p className="text-slate-400 mt-2 text-sm max-w-2xl font-light leading-relaxed">
          5-element FDFD phased array at the transmitter. The sparse LU factorization is cached once, then the
          antenna scans the complete 360° region in 5° steps (72 scientifically ordered frames) before
          targeting any weak node. This keeps the notebook physics while making the beam and node interaction visible.
        </p>
      </div>

      {/* ── Main 2-col layout ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">

        {/* Left panel */}
        <div className="xl:col-span-4 space-y-5">

          {/* Config */}
          <div className="bg-card border border-border rounded p-5 space-y-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 border-b border-border pb-2 flex items-center gap-2">
              <Zap size={13} className="text-primary" /> Parameters
            </h3>
            <div className="space-y-3">
              <ParamField label="Per-Element TX Power (dBm)"
                help="Power from each of the 5 array elements"
                disabled={isRunning}
                value={cfg.txPowerDbm}
                onChange={(v) => setCfg((c) => ({ ...c, txPowerDbm: v }))} />
              <ParamField label="RSSI Threshold (dBm)"
                help="Nodes below this are targeted for beam steering"
                disabled={isRunning}
                value={cfg.targetRssiThreshold}
                onChange={(v) => setCfg((c) => ({ ...c, targetRssiThreshold: v }))} />
              <ParamField label="Steering Iterations"
                help="Number of electronic beam-steering steps"
                disabled={isRunning}
                min={1} max={50} integer
                value={cfg.nIterations}
                onChange={(v) => setCfg((c) => ({ ...c, nIterations: v }))} />
              <ParamField label="Scan Angle Step (degrees)"
                help="5° = 72 full-region frames across 0°–355°"
                disabled={isRunning}
                min={5} max={5}
                value={cfg.stepAngle}
                onChange={() => setCfg((c) => ({ ...c, stepAngle: 5 }))} />
            </div>
            <Button
              onClick={startRun}
              disabled={!stage2RunId || isRunning}
              className="w-full gap-2 uppercase tracking-widest text-xs h-9 rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-40"
            >
              {isRunning ? (
                <><Spinner /> Running…</>
              ) : status === "done" ? (
                <><RotateCcw size={13} /> Re-Run</>
              ) : (
                <><Play size={13} /> Run Simulation</>
              )}
            </Button>
            {!stage2RunId && (
              <p className="text-[10px] text-destructive font-mono text-center">
                No stage2RunId — navigate here from Phase 02 (Node Placement).
              </p>
            )}
          </div>

          {/* Progress */}
          {status !== "idle" && (
            <div className="bg-card border border-border rounded p-5 space-y-3">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 border-b border-border pb-2 flex items-center gap-2">
                <Activity size={13} className="text-primary" /> Progress
              </h3>
              {initInfo && (
                <div className="space-y-1.5">
                  <StatRow label="Nodes"       value={String(initInfo.nodeCount)} />
                  <StatRow label="Weak nodes"  value={String(initInfo.weakNodeCount)} />
                  <StatRow label="Beam angles" value={String(initInfo.totalAngles)} />
                </div>
              )}
              {(status === "precomputing" || status === "creating") && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] font-mono text-slate-400">
                    <span>{status === "creating" ? "Creating run…" : "Pre-computing angles…"}</span>
                    <span>{precomputePct}%</span>
                  </div>
                  <div className="h-1.5 bg-border rounded-full overflow-hidden">
                    <div className="h-full bg-primary transition-all duration-300 rounded-full" style={{ width: `${precomputePct}%` }} />
                  </div>
                  <p className="text-[10px] text-slate-600 font-mono">LU cached once → {initInfo?.totalAngles ?? 72} angle solves; frames stream while rendering</p>
                </div>
              )}
              {status === "streaming" && (
                <div className="text-[10px] font-mono text-primary animate-pulse text-center">
                  ● Streaming frames… ({frames.length} received)
                </div>
              )}
              {doneInfo && (
                <div className="space-y-1.5">
                  <StatRow label="Total frames"  value={String(doneInfo.totalFrames ?? "—")} accent />
                  <StatRow label="Exec time"     value={`${((Number(doneInfo.executionTimeMs) || 0) / 1000).toFixed(1)}s`} />
                  <StatRow label="Unreachable"   value={String(doneInfo.unreachableCount ?? 0)} />
                </div>
              )}
              {status === "done" && (
                <p className="text-[10px] text-green-400 font-mono text-center">✓ Complete</p>
              )}
            </div>
          )}

          {/* Video controls — only after done */}
          {canPlay && (
            <div className="bg-card border border-border rounded p-5 space-y-4">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 border-b border-border pb-2 flex items-center gap-2">
                <Layers size={13} className="text-primary" /> Video Controls
              </h3>

              {/* Frame type badge */}
              {currentFrame && (
                <div className="text-[10px] font-mono text-center bg-primary/10 border border-primary/20 rounded px-2 py-1.5 text-primary font-bold uppercase tracking-widest">
                  {FRAME_TYPE_LABEL[currentFrame.frameType]}
                </div>
              )}

              {/* Play/Pause + speed */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (playhead >= frames.length - 1 && !playing) setPlayhead(0);
                    setPlaying((v) => !v);
                  }}
                  className="flex items-center justify-center w-9 h-9 rounded bg-primary text-white hover:bg-primary/90 transition-colors"
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button
                  onClick={() => { setPlaying(false); setPlayhead(0); }}
                  className="flex items-center justify-center w-9 h-9 rounded border border-border text-slate-400 hover:text-white hover:bg-secondary transition-colors"
                >
                  <RotateCcw size={14} />
                </button>
                <div className="flex gap-1 ml-auto">
                  {SPEEDS.map((s, i) => (
                    <button key={i} onClick={() => setSpeedIdx(i)}
                      className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${
                        speedIdx === i ? "border-primary bg-primary/10 text-primary" : "border-border text-slate-500 hover:text-slate-300"
                      }`}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Frame counter */}
              <div className="flex justify-between text-[10px] font-mono text-slate-400">
                <span>Frame</span>
                <span>{playhead + 1} / {frames.length}</span>
              </div>

              {/* Scrubber */}
              <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={playhead}
                onChange={(e) => { setPlaying(false); setPlayhead(Number(e.target.value)); }}
                className="w-full accent-primary cursor-pointer" />

              {/* Prev/Next arrows */}
              <div className="flex items-center justify-between gap-2">
                <button
                  disabled={playhead === 0}
                  onClick={() => { setPlaying(false); setPlayhead((i) => Math.max(0, i - 1)); }}
                  className="flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-white disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft size={13} /> Prev
                </button>
                <button
                  disabled={playhead >= frames.length - 1}
                  onClick={() => { setPlaying(false); setPlayhead((i) => Math.min(frames.length - 1, i + 1)); }}
                  className="flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-white disabled:opacity-30 transition-colors"
                >
                  Next <ChevronRight size={13} />
                </button>
              </div>

              {/* Steering metadata */}
              {currentFrame?.frameType === "steering" && (
                <div className="space-y-1.5 pt-1 border-t border-border">
                  <StatRow label="Iteration"   value={`${currentFrame.metadata.iteration}/${currentFrame.metadata.totalIterations}`} />
                  <StatRow label="Beam angle"  value={`${Number(currentFrame.metadata.angle ?? 0).toFixed(0)}°`} accent />
                  <StatRow label="Target node" value={`#${String(currentFrame.metadata.targetNodeId ?? "—").padStart(2, "0")}`} />
                  <StatRow label="Baseline"    value={`${Number(currentFrame.metadata.baselineRssi ?? 0).toFixed(1)} dBm`} />
                  <StatRow label="Delivered"   value={`${Number(currentFrame.metadata.deliveredRssi ?? 0).toFixed(1)} dBm`} accent />
                  {Boolean(currentFrame.metadata.unreachable) && (
                    <p className="text-[10px] text-amber-400 font-mono">⚠ Node marked unreachable</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Physics explainer */}
          <div className="bg-card border border-border rounded p-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2 flex items-center gap-1.5">
              <Info size={10} /> Physics
            </p>
            <p className="text-[10px] text-slate-500 leading-relaxed font-mono">
              5-element ULA · d = λ/2 · Helmholtz FDM · 20-px absorbing sponge boundary.
              LU factored once; all cached scan angles reuse the same decomposition from the Python notebook solver.
              Steering is electronic (phase shifts only — no mechanical movement).
              Max-hold = pixel-wise maximum dB across the full 360° sweep.
            </p>
          </div>
        </div>

        {/* Right panel — video + output images */}
        <div className="xl:col-span-8 space-y-6">

          {/* ── Precompute loading state ───────────────────────────────── */}
          {(status === "creating" || status === "precomputing") && (
            <div className="flex flex-col items-center justify-center gap-6 py-24 bg-card border border-border rounded">
              <div className="relative w-20 h-20">
                <div className="absolute inset-0 border-2 border-primary/20 rounded-full" />
                <div className="absolute inset-0 border-2 border-t-primary rounded-full animate-spin" />
                <Antenna size={28} className="absolute inset-0 m-auto text-primary" />
              </div>
              <div className="text-center space-y-2">
                <p className="text-white font-bold uppercase tracking-widest text-sm">
                  {status === "creating" ? "Preparing Run…" : "Pre-Computing All Beam Angles"}
                </p>
                {status === "precomputing" && (
                  <>
                    <p className="text-primary font-mono text-xs">
                        {precomputePct}% — {Math.round(precomputePct * (initInfo?.totalAngles ?? 72) / 100)} / {initInfo?.totalAngles ?? 72} angles solved
                    </p>
                    <p className="text-slate-600 text-xs">Frames stream in real-time after this step</p>
                  </>
                )}
              </div>
              <div className="w-48 h-1.5 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-500 rounded-full"
                  style={{ width: `${precomputePct}%` }} />
              </div>
            </div>
          )}

          {/* ── Error state ───────────────────────────────────────────── */}
          {status === "error" && (
            <div className="bg-destructive/10 border border-destructive/30 rounded p-6 flex gap-4 relative overflow-hidden">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-destructive" />
              <AlertCircle className="text-destructive shrink-0" size={22} />
              <div className="space-y-2">
                <h3 className="text-destructive font-bold uppercase tracking-widest text-sm">Simulation Failed</h3>
                <p className="text-destructive/80 text-sm font-mono">{errorMsg}</p>
                <Button size="sm" variant="outline"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10 text-xs mt-2"
                  onClick={startRun}>Retry</Button>
              </div>
            </div>
          )}

          {/* ── Idle prompt ───────────────────────────────────────────── */}
          {status === "idle" && (
            <div className="flex flex-col items-center justify-center gap-4 py-24 bg-card border border-dashed border-border rounded text-center">
              <Radio size={40} className="text-slate-700" />
              <div>
                <p className="text-slate-400 font-bold uppercase tracking-widest text-sm">Ready to Simulate</p>
                <p className="text-slate-600 text-xs mt-1 max-w-sm font-mono">
                  Configure parameters on the left, then click Run to start the phased array simulation.
                </p>
              </div>
            </div>
          )}

          {/* ── Live video viewer ─────────────────────────────────────── */}
          {frames.length > 0 && (
            <div className="bg-card border border-border rounded overflow-hidden">
              {/* Title bar */}
              <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {status === "streaming" && (
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" title="Live" />
                  )}
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-300 font-mono">
                    {currentFrame ? FRAME_TYPE_LABEL[currentFrame.frameType] : "Initializing…"}
                  </span>
                  {currentFrame?.frameType === "steering" && (
                    <span className="text-[10px] font-mono text-primary border border-primary/30 bg-primary/5 rounded px-1.5 py-0.5">
                      {Number(currentFrame.metadata.angle ?? 0).toFixed(0)}°
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* Full-screen / lightbox */}
                  {currentFrame && (
                    <button
                      onClick={() => setLightboxIdx(playhead)}
                      className="text-slate-500 hover:text-white transition-colors"
                      title="Full screen"
                    >
                      <Maximize2 size={14} />
                    </button>
                  )}
                  {/* Download current frame */}
                  {currentFrame && (
                    <a
                      href={currentFrame.imageBase64}
                      download={frameFilename(currentFrame)}
                      className="flex items-center gap-1 text-[10px] font-mono text-slate-500 hover:text-primary transition-colors uppercase tracking-widest"
                    >
                      <Download size={12} /> Export
                    </a>
                  )}
                </div>
              </div>

              {/* Frame image with smooth cross-fade */}
              {currentFrame && (
                <div className="relative w-full bg-[#111118]">
                  <img
                    key={currentFrame.frameIdx}
                    src={currentFrame.imageBase64}
                    alt={FRAME_TYPE_LABEL[currentFrame.frameType]}
                    className="w-full h-auto object-contain"
                    style={{ transition: "opacity 0.18s ease" }}
                  />
                </div>
              )}

              {/* Progress bar during streaming */}
              {status === "streaming" && (
                <div className="h-0.5 bg-border">
                  <div className="h-full bg-primary animate-pulse" style={{ width: "100%" }} />
                </div>
              )}

              {/* Legend */}
              <div className="px-4 py-2.5 border-t border-border flex flex-wrap gap-4 text-[10px] font-mono text-slate-400">
                <LegendDot color="bg-yellow-400"  label="Current target" />
                <LegendDot color="bg-red-500"     label="Searchable node" />
                <LegendDot color="bg-gray-500"    label="Unreachable" />
                <LegendDot color="bg-fuchsia-500" label="Phased array ★" />
                <LegendDot color="bg-cyan-400/50" label="Beam wedge" />
              </div>
            </div>
          )}

          {status === "done" && videoUrl && (
            <div className="bg-card border border-primary/20 rounded overflow-hidden">
              <div className="px-4 py-2.5 border-b border-primary/20 flex items-center justify-between bg-primary/5">
                <span className="text-xs font-bold uppercase tracking-widest text-primary font-mono">Rendered Simulation Video</span>
                <a href={videoUrl} download className="flex items-center gap-1.5 text-[10px] text-primary hover:text-white transition-colors font-mono uppercase tracking-widest">
                  <Download size={12} /> Download MP4
                </a>
              </div>
              <video key={videoUrl} src={videoUrl} controls preload="metadata" className="w-full bg-black" aria-label="Phased array beam steering simulation video" />
              <p className="px-4 py-2 text-[10px] font-mono text-slate-500">Generated from the same Python solver frames shown above.</p>
            </div>
          )}

          {/* ── Max-hold output image ─────────────────────────────────── */}
          {maxHoldFrame && (
            <div className="bg-card border border-primary/20 rounded overflow-hidden">
              <div className="px-4 py-2.5 border-b border-primary/20 flex items-center justify-between bg-primary/5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  <span className="text-xs font-bold uppercase tracking-widest text-primary font-mono">
                    Final Output — Max-Hold Coverage Map
                  </span>
                </div>
                <a
                  href={maxHoldFrame.imageBase64}
                  download="phased-array-max-hold-360deg.png"
                  className="flex items-center gap-1.5 text-xs text-primary hover:text-white transition-colors font-mono uppercase tracking-widest border border-primary/30 px-2 py-1 rounded hover:bg-primary/20"
                >
                  <Download size={12} /> Download Image
                </a>
                <button
                  onClick={exportResults}
                  disabled={exporting || !stage4RunId}
                  className="flex items-center gap-1.5 text-xs text-primary hover:text-white disabled:opacity-40 transition-colors font-mono uppercase tracking-widest border border-primary/30 px-2 py-1 rounded hover:bg-primary/20"
                >
                  <Download size={12} /> {exporting ? "Preparing…" : "Export Heatmap + Placement"}
                </button>
              </div>
              <img
                src={maxHoldFrame.imageBase64}
                alt="Max-hold 360° coverage"
                className="w-full h-auto object-contain cursor-pointer"
                onClick={() => setLightboxIdx(frames.indexOf(maxHoldFrame))}
              />
              <div className="px-4 py-2 bg-primary/5 text-[10px] font-mono text-primary/70 text-center">
              Best achievable signal at every pixel across the complete 360° scan (5° default step)
              </div>
            </div>
          )}

          {/* ── Output image gallery ──────────────────────────────────── */}
          {frames.length > 1 && (
            <div className="bg-card border border-border rounded p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                    <Layers size={12} className="text-primary" /> Recent Output Images ({frames.length})
                </h3>
                {status === "done" && (
                  <button
                    onClick={() => frames.forEach((f, i) => setTimeout(() => download(f.imageBase64, frameFilename(f)), i * 80))}
                    className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 hover:text-primary transition-colors uppercase tracking-widest"
                  >
                    <Download size={11} /> Download Recent
                  </button>
                )}
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                {frames.map((f, i) => (
                  <div key={i} className="relative group">
                    <button
                      onClick={() => { setPlaying(false); setPlayhead(i); }}
                      className={`w-full rounded overflow-hidden border-2 transition-all block ${
                        i === playhead ? "border-primary shadow-[0_0_8px_rgba(var(--primary)/0.5)]" : "border-border hover:border-slate-500"
                      }`}
                    >
                      <img src={f.imageBase64} alt={`Frame ${i}`} className="w-full h-auto block" />
                    </button>
                    {/* Download button on hover */}
                    <a
                      href={f.imageBase64}
                      download={frameFilename(f)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-1 right-1 bg-background/80 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Download"
                    >
                      <Download size={9} className="text-primary" />
                    </a>
                    {/* Type label */}
                    <div className={`text-[8px] font-mono text-center py-0.5 leading-tight ${
                      i === playhead ? "bg-primary text-white" : "bg-background/50 text-slate-600"
                    }`}>
                      {f.frameType === "steering"
                        ? `${Number(f.metadata.angle ?? 0).toFixed(0)}°`
                        : f.frameType.replace("_", " ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Navigation ────────────────────────────────────────────────────── */}
      <div className="flex justify-between pt-8 border-t border-border">
        <Button
          variant="outline"
          onClick={() => setLocation(`/simulator/stage-2?runId=${stage1RunId}`)}
          className="gap-2 border-border text-slate-300 hover:bg-secondary hover:text-white uppercase tracking-widest text-xs h-10 rounded"
        >
          <ArrowLeft size={16} /> Node Placement
        </Button>
        <Button
          onClick={() => stage4RunId && setLocation(`/simulator/stage-5?${buildNavQuery({ stage4RunId })}`)}
          disabled={status !== "done" || !stage4RunId}
          className="gap-2 uppercase tracking-widest text-xs h-10 rounded bg-primary text-white hover:bg-primary/90"
        >
          Engineering Analysis <ArrowRight size={16} />
        </Button>
      </div>

      {/* ── Lightbox ──────────────────────────────────────────────────────── */}
      {lightboxIdx !== null && frames[lightboxIdx] && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4"
          onClick={() => setLightboxIdx(null)}
        >
          <div className="relative max-w-5xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-xs font-mono text-white uppercase tracking-widest">
                {FRAME_TYPE_LABEL[frames[lightboxIdx].frameType]}
                {(frames[lightboxIdx].frameType === "steering" || frames[lightboxIdx].frameType === "scan") &&
                  ` — ${Number(frames[lightboxIdx].metadata.angle ?? 0).toFixed(frames[lightboxIdx].frameType === "scan" ? 1 : 0)}°`}
              </span>
              <div className="flex items-center gap-3">
                <a
                  href={frames[lightboxIdx].imageBase64}
                  download={frameFilename(frames[lightboxIdx])}
                  className="flex items-center gap-1 text-xs font-mono text-primary hover:text-white transition-colors uppercase tracking-widest"
                >
                  <Download size={13} /> Download
                </a>
                <button onClick={() => setLightboxIdx(null)} className="text-white hover:text-red-400 transition-colors">
                  <X size={18} />
                </button>
              </div>
            </div>
            <img
              src={frames[lightboxIdx].imageBase64}
              alt={FRAME_TYPE_LABEL[frames[lightboxIdx].frameType]}
              className="w-full h-auto rounded shadow-2xl"
            />
            {/* Prev / Next in lightbox */}
            <div className="flex justify-between mt-3">
              <button
                disabled={lightboxIdx === 0}
                onClick={() => setLightboxIdx((i) => (i !== null ? Math.max(0, i - 1) : 0))}
                className="flex items-center gap-1 text-xs font-mono text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span className="text-xs font-mono text-slate-500">{lightboxIdx + 1} / {frames.length}</span>
              <button
                disabled={lightboxIdx >= frames.length - 1}
                onClick={() => setLightboxIdx((i) => (i !== null ? Math.min(frames.length - 1, i + 1) : 0))}
                className="flex items-center gap-1 text-xs font-mono text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ParamField({
  label, help, value, onChange, disabled = false, min, max, integer = false,
}: {
  label: string; help?: string; value: number; onChange: (v: number) => void;
  disabled?: boolean; min?: number; max?: number; integer?: boolean;
}) {
  return (
    <div>
      <Label className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1 block">{label}</Label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const v = integer ? parseInt(e.target.value) : parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        className="font-mono text-sm h-8 bg-background border-border"
      />
      {help && <p className="text-[10px] text-slate-600 mt-0.5">{help}</p>}
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

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span>{label}</span>
    </div>
  );
}

function Spinner() {
  return <div className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />;
}
