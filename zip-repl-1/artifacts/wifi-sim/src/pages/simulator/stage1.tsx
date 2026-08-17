import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { useCreateStage1Run, useGetStage1Run, useListStage1Runs } from "@workspace/api-client-react";
import { UploadCloud, FileImage, Settings, Play, ChevronRight, Activity, AlertCircle, ArrowRight, MousePointer2, Maximize2, Download, Minimize2, SplitSquareHorizontal, Crop, CheckCircle2, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";

import jsPDF from "jspdf";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── ROI Selector ────────────────────────────────────────────────────────────

function RoiSelector({
  heatmapSrc,
  onConfirm,
  onReset,
  existingRoi,
  isConfirmed,
  isConfirming,
}: {
  heatmapSrc: string;
  onConfirm: (roi: Roi) => void;
  onReset?: () => void;
  existingRoi?: Roi;
  isConfirmed: boolean;
  isConfirming: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);

  // Dragging state (in container-pixel coordinates)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);

  // Existing ROI displayed as initial selection (convert back to container coords on render)
  const [roi, setRoi] = useState<Roi | null>(existingRoi ?? null);

  // Record natural dimensions once image loads
  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  // Convert container pixel → natural image pixel
  const toNatural = useCallback(
    (cx: number, cy: number): { x: number; y: number } => {
      const container = containerRef.current;
      const img = imgRef.current;
      if (!container || !img || !imgNatural) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      // Image fills the full container width; height = width * aspect
      const scaleX = imgNatural.w / rect.width;
      const scaleY = imgNatural.h / rect.height;
      return {
        x: Math.round(Math.max(0, Math.min(cx, rect.width)) * scaleX),
        y: Math.round(Math.max(0, Math.min(cy, rect.height)) * scaleY),
      };
    },
    [imgNatural],
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setDragStart({ x: cx, y: cy });
    setDragEnd({ x: cx, y: cy });
    setRoi(null);
    onReset?.();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStart) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setDragEnd({
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    });
  };

  const handlePointerUp = () => {
    if (!dragStart || !dragEnd || !imgNatural) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const x0 = Math.min(dragStart.x, dragEnd.x);
    const y0 = Math.min(dragStart.y, dragEnd.y);
    const x1 = Math.max(dragStart.x, dragEnd.x);
    const y1 = Math.max(dragStart.y, dragEnd.y);

    if (x1 - x0 < 10 || y1 - y0 < 10) {
      // Too small — ignore
      setDragStart(null);
      setDragEnd(null);
      return;
    }

    // Convert corners to natural image coordinates
    const scaleX = imgNatural.w / rect.width;
    const scaleY = imgNatural.h / rect.height;
    const newRoi: Roi = {
      x: Math.round(x0 * scaleX),
      y: Math.round(y0 * scaleY),
      width: Math.round((x1 - x0) * scaleX),
      height: Math.round((y1 - y0) * scaleY),
    };
    setRoi(newRoi);
    setDragStart(null);
    setDragEnd(null);
  };

  // Compute overlay rect in container-pixel coordinates for the confirmed ROI
  const roiContainerRect =
    roi && imgNatural && containerRef.current
      ? (() => {
          const rect = containerRef.current!.getBoundingClientRect();
          const scaleX = rect.width / imgNatural.w;
          const scaleY = rect.height / imgNatural.h;
          return {
            left: roi.x * scaleX,
            top: roi.y * scaleY,
            width: roi.width * scaleX,
            height: roi.height * scaleY,
          };
        })()
      : null;

  // Compute drag-in-progress rect in container pixels
  const dragRect =
    dragStart && dragEnd
      ? {
          left: Math.min(dragStart.x, dragEnd.x),
          top: Math.min(dragStart.y, dragEnd.y),
          width: Math.abs(dragEnd.x - dragStart.x),
          height: Math.abs(dragEnd.y - dragStart.y),
        }
      : null;

  const handleConfirm = () => {
    if (!roi || isConfirming) return;
    onConfirm(roi);
  };

  const handleReset = () => {
    setRoi(null);
    onReset?.();
  };

  return (
    <div className="space-y-3">
      {/* Instructions */}
      <div className="bg-primary/10 border border-primary/30 rounded p-3 flex gap-3 items-start">
        <Crop size={14} className="text-primary mt-0.5 shrink-0" />
        <div className="text-xs text-slate-300 space-y-1">
          <p className="font-semibold text-primary uppercase tracking-widest text-[10px]">Select Heatmap ROI</p>
          <p>Click and drag to select the <strong>actual heatmap area</strong> — exclude the colorbar, title, and white margins. This region defines the valid domain for node placement.</p>
        </div>
      </div>

      {/* Controls stay above the image so the required action is always
          discoverable; the button enables after a rectangle is drawn. */}
      <div className="flex items-center justify-between rounded border border-border bg-background/60 px-3 py-2">
        <div className="text-[10px] font-mono text-slate-500">
          {roi
            ? `ROI: ${roi.x},${roi.y}  ${roi.width}×${roi.height} px`
            : "No selection — drag on the image below"}
        </div>
        <div className="flex gap-2">
          {roi && !isConfirmed && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={isConfirming}
              className="h-7 text-[10px] uppercase tracking-widest gap-1 border-border"
            >
              <RotateCcw size={11} /> Redraw
            </Button>
          )}
          {isConfirmed && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              className="h-7 text-[10px] uppercase tracking-widest gap-1 border-border"
            >
              <RotateCcw size={11} /> Change ROI
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!roi || isConfirmed || isConfirming}
            className={`h-7 text-[10px] uppercase tracking-widest gap-1 ${
              isConfirmed
                ? "bg-green-600 text-white cursor-default"
                : isConfirming
                  ? "bg-primary/60 text-white cursor-wait"
                  : "bg-primary text-white hover:bg-primary/90"
            }`}
          >
            {isConfirmed ? (
              <><CheckCircle2 size={11} /> Confirmed</>
            ) : isConfirming ? (
              <><span className="animate-pulse">Confirming…</span></>
            ) : (
              <><CheckCircle2 size={11} /> Confirm ROI</>
            )}
          </Button>
        </div>
      </div>

      {/* Image + overlay */}
      <div
        ref={containerRef}
        className="relative select-none rounded overflow-hidden border border-border bg-black cursor-crosshair max-h-[280px]"
        style={imgNatural ? {
          aspectRatio: `${imgNatural.w} / ${imgNatural.h}`,
          // Keep the selection controls within the first viewport on desktop
          // while preserving the rendered image's independent X/Y scaling.
          height: "min(calc(100vw / 2.1), 280px)",
        } : {}}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img
          ref={imgRef}
          src={heatmapSrc.startsWith("data:") ? heatmapSrc : `data:image/png;base64,${heatmapSrc}`}
          alt="Heatmap for ROI selection"
          className="w-full h-full object-fill pointer-events-none block"
          draggable={false}
          onLoad={handleImageLoad}
        />

        {/* Drag-in-progress rectangle */}
        {dragRect && (
          <div
            className="absolute border-2 border-dashed border-yellow-400 bg-yellow-400/10 pointer-events-none"
            style={{
              left: dragRect.left,
              top: dragRect.top,
              width: dragRect.width,
              height: dragRect.height,
            }}
          />
        )}

        {/* Confirmed ROI overlay */}
        {roi && roiContainerRect && (
          <>
            {/* Dimmed areas outside ROI */}
            <div className="absolute inset-0 pointer-events-none">
              {/* top strip */}
              <div
                className="absolute bg-black/50"
                style={{ left: 0, top: 0, right: 0, height: roiContainerRect.top }}
              />
              {/* bottom strip */}
              <div
                className="absolute bg-black/50"
                style={{
                  left: 0,
                  top: roiContainerRect.top + roiContainerRect.height,
                  right: 0,
                  bottom: 0,
                }}
              />
              {/* left strip */}
              <div
                className="absolute bg-black/50"
                style={{
                  left: 0,
                  top: roiContainerRect.top,
                  width: roiContainerRect.left,
                  height: roiContainerRect.height,
                }}
              />
              {/* right strip */}
              <div
                className="absolute bg-black/50"
                style={{
                  left: roiContainerRect.left + roiContainerRect.width,
                  top: roiContainerRect.top,
                  right: 0,
                  height: roiContainerRect.height,
                }}
              />
            </div>

            {/* ROI border */}
            <div
              className={`absolute border-2 pointer-events-none ${isConfirmed ? "border-green-400" : "border-yellow-400 border-dashed"}`}
              style={{
                left: roiContainerRect.left,
                top: roiContainerRect.top,
                width: roiContainerRect.width,
                height: roiContainerRect.height,
              }}
            >
              {isConfirmed && (
                <div className="absolute -top-5 left-0 flex items-center gap-1 text-[10px] font-mono font-bold text-green-400 whitespace-nowrap">
                  <CheckCircle2 size={10} /> ROI CONFIRMED
                </div>
              )}
            </div>
          </>
        )}
      </div>

    </div>
  );
}

// ─── Main Stage 1 page ───────────────────────────────────────────────────────

export default function Stage1() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const runIdFromUrl = params.get("runId");

  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [formData, setFormData] = useState({
    cellSizeMeters: "0.5",
    realWidthMeters: "",
    frequencyMHz: "50",
    refractiveIndex: "2",
    absorptionCoeff: "0.062",
    sourceValue: "22",
    minDb: "-80",
    pmlWidth: "20",
    pmlMaxLoss: "0.5",
    alpha3dBump: "0",
    sourceXPercent: "10",
    sourceYPercent: "5",
    cellBudget: "260000"
  });

  const [simProgressIndex, setSimProgressIndex] = useState(0);

  const createRun = useCreateStage1Run();
  
  const { data: existingRun } = useGetStage1Run(runIdFromUrl || "", {
    query: {
      enabled: !!runIdFromUrl,
      queryKey: ["getStage1Run", runIdFromUrl]
    }
  });

  const progressMessages = [
    "Preparing Computational Grid...",
    "Allocating Memory Matrix...",
    "Applying Material Properties...",
    "Setting Boundary Conditions (PML)...",
    "Running FDFD Solver...",
    "Computing Electromagnetic Wave Propagation...",
    "Generating Result Heatmap...",
    "Finalizing Export..."
  ];

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (createRun.isPending) {
      setSimProgressIndex(0);
      interval = setInterval(() => {
        setSimProgressIndex(prev => {
          if (prev < progressMessages.length - 1) return prev + 1;
          return prev;
        });
      }, 1500);
    }
    return () => clearInterval(interval);
  }, [createRun.isPending]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: any = {};
    if (!file) {
      toast({
        title: "Missing blueprint",
        description: "Please upload a structural floor plan image to simulate.",
        variant: "destructive"
      });
      return;
    }
    payload.map = file;
    Object.entries(formData).forEach(([key, value]) => {
      if (value.trim() !== "") payload[key] = Number(value);
    });
    createRun.mutate({ data: payload }, {
      onSuccess: (run) => {
        toast({
          title: "Simulation Complete",
          description: `Grid computed in ${(run.executionTimeMs / 1000).toFixed(2)}s`,
        });
        setLocation(`/simulator/stage-1?runId=${run.runId}`);
      },
      onError: (err) => {
        toast({
          title: "Simulation Failed",
          description: err.data?.error || "An error occurred during FDFD computation.",
          variant: "destructive"
        });
      }
    });
  };

  const isSimulating = createRun.isPending;
  const result = existingRun || createRun.data;

  return (
    <div className="max-w-[1400px] mx-auto space-y-6 pb-20">
      
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-3">
            <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded text-sm border border-primary/20">Stage 01</span>
            Heatmap Generation
          </h1>
          <p className="text-slate-400 mt-2 text-sm max-w-xl font-light">
            Configure material properties and bounds. The solver maps the uploaded image to a Cartesian grid and computes the steady-state EM field.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        
        {/* Left Col: Config & Form */}
        <div className="xl:col-span-4 space-y-6">
          <form onSubmit={handleSubmit} className="bg-card border border-border rounded flex flex-col shadow-xl">
            <div className="p-4 border-b border-border bg-slate-900/50 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-200 flex items-center gap-2">
                <Settings size={16} className="text-primary" /> Matrix Parameters
              </h2>
            </div>
            
            <div className="p-5 space-y-6 overflow-y-auto max-h-[calc(100vh-250px)]">
              <div className="space-y-3">
                <Label htmlFor="map-upload" className="text-[11px] uppercase tracking-widest font-semibold text-slate-300">Structural Blueprint <span className="text-destructive">*</span></Label>
                <div className="border border-dashed border-border rounded p-6 text-center hover:border-primary/50 hover:bg-primary/5 transition-all relative group bg-background/50">
                  <input
                    type="file"
                    id="map-upload"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="flex flex-col items-center gap-2 text-slate-400 pointer-events-none">
                    {file ? (
                      <>
                        <FileImage size={24} className="text-primary" />
                        <span className="text-xs font-mono text-white truncate max-w-[200px]">{file.name}</span>
                        <span className="text-[10px]">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud size={24} className="group-hover:text-primary transition-colors" />
                        <span className="text-xs font-medium uppercase tracking-wider">Select Blueprint</span>
                        <span className="text-[10px] opacity-70">PNG, JPG up to 10MB</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <Accordion type="single" collapsible defaultValue="source" className="w-full">
                <AccordionItem value="spatial" className="border-border">
                  <AccordionTrigger className="text-[11px] uppercase tracking-widest font-semibold py-3 hover:no-underline text-slate-300">Spatial Calibration</AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Cell Size (m)</Label>
                        <Input name="cellSizeMeters" value={formData.cellSizeMeters} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Real Width (m)</Label>
                        <Input name="realWidthMeters" value={formData.realWidthMeters} onChange={handleInputChange} placeholder="Auto" className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5 col-span-2">
                        <Label className="text-[10px] uppercase text-slate-400">Cell Budget Limit</Label>
                        <Input name="cellBudget" value={formData.cellBudget} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
                
                <AccordionItem value="physics" className="border-border">
                  <AccordionTrigger className="text-[11px] uppercase tracking-widest font-semibold py-3 hover:no-underline text-slate-300">Electromagnetics</AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Proxy Freq (MHz)</Label>
                        <Input name="frequencyMHz" value={formData.frequencyMHz} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">3D Alpha Bump</Label>
                        <Input name="alpha3dBump" value={formData.alpha3dBump} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Refractive Index</Label>
                        <Input name="refractiveIndex" value={formData.refractiveIndex} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Absorption (1/m)</Label>
                        <Input name="absorptionCoeff" value={formData.absorptionCoeff} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="source" className="border-border border-b-0">
                  <AccordionTrigger className="text-[11px] uppercase tracking-widest font-semibold py-3 hover:no-underline text-slate-300">Antenna / Source & Boundaries</AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="rounded border border-primary/20 bg-primary/5 p-3 text-[10px] font-mono text-slate-400 leading-relaxed">
                      The antenna is the FDFD electric-field source (TX). Set its position as a percentage of the
                      uploaded map below, then run the heatmap again. If the selected cell is inside a wall, the solver
                      moves it to the nearest open cell and reports that adjustment.
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Antenna X / TX (%)</Label>
                        <Input type="number" min="0" max="100" step="0.1" name="sourceXPercent" value={formData.sourceXPercent} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Antenna Y / TX (%)</Label>
                        <Input type="number" min="0" max="100" step="0.1" name="sourceYPercent" value={formData.sourceYPercent} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Amplitude (V/m)</Label>
                        <Input name="sourceValue" value={formData.sourceValue} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[10px] uppercase text-slate-400">Min Plot dB</Label>
                        <Input name="minDb" value={formData.minDb} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                      </div>
                      <div className="space-y-1.5 col-span-2 grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label className="text-[10px] uppercase text-slate-400">PML Width (cells)</Label>
                          <Input name="pmlWidth" value={formData.pmlWidth} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-[10px] uppercase text-slate-400">PML Max Loss</Label>
                          <Input name="pmlMaxLoss" value={formData.pmlMaxLoss} onChange={handleInputChange} className="font-mono text-xs h-8 bg-background/50 rounded-sm border-border" />
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>

            <div className="p-4 border-t border-border mt-auto bg-background/20">
              <motion.button 
                type="submit" 
                whileHover={isSimulating ? {} : { scale: 1.02 }}
                whileTap={isSimulating ? {} : { scale: 0.98 }}
                className={`w-full rounded uppercase tracking-widest text-[10px] font-bold h-10 transition-all ${isSimulating ? 'bg-secondary text-primary' : 'bg-primary text-white hover:bg-primary/90 glow-primary'}`}
                disabled={isSimulating}
              >
                {isSimulating ? (
                  <span className="animate-pulse">Solving Matrix...</span>
                ) : (
                  <span className="flex items-center justify-center gap-2"><Play size={14} fill="currentColor" /> Initialize FDFD Run</span>
                )}
              </motion.button>
            </div>
          </form>
        </div>

        {/* Right Col: Output View */}
        <div className="xl:col-span-8 flex flex-col h-[calc(100vh-140px)] min-h-[600px]">
          {isSimulating ? (
            <div className="flex-1 border border-border rounded bg-card flex flex-col items-center justify-center p-12 text-center relative overflow-hidden shadow-lg">
              <div className="absolute inset-0 bg-[linear-gradient(rgba(0,163,255,0.03)_1px,transparent_1px)] bg-[length:100%_4px] pointer-events-none" />
              
              <div className="relative w-32 h-32 mb-8">
                <div className="absolute inset-0 border border-primary/20 rounded-full animate-[spin_4s_linear_infinite]" />
                <div className="absolute inset-2 border-2 border-transparent border-t-primary rounded-full animate-[spin_1.5s_cubic-bezier(0.5,0.1,0.5,0.9)_infinite] glow-primary" />
                <div className="absolute inset-6 border border-accent/20 rounded-full animate-[spin_3s_linear_infinite_reverse]" />
                <div className="absolute inset-0 m-auto w-2 h-2 bg-primary rounded-full glow-primary animate-pulse" />
              </div>

              <div className="space-y-4 max-w-md w-full relative z-10">
                <AnimatePresence mode="wait">
                  <motion.h3 
                    key={simProgressIndex}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3 }}
                    className="text-lg font-mono font-bold text-primary uppercase tracking-widest"
                  >
                    {progressMessages[simProgressIndex]}
                  </motion.h3>
                </AnimatePresence>
                
                <div className="flex justify-between text-[10px] font-mono text-primary/70 mb-1">
                  <span>Step {simProgressIndex + 1}/{progressMessages.length}</span>
                  <span>{Math.round(((simProgressIndex + 1) / progressMessages.length) * 100)}%</span>
                </div>
                <div className="w-full bg-background border border-primary/30 h-1.5 rounded overflow-hidden">
                  <div 
                    className="h-full bg-primary transition-all duration-800 ease-out glow-primary"
                    style={{ width: `${((simProgressIndex + 1) / progressMessages.length) * 100}%` }}
                  />
                </div>
                
                <p className="text-xs text-slate-500 font-mono mt-4">
                  Inverting sparse matrix using continuous-wave formulation. 
                  Larger cell budgets require non-linear compute time.
                </p>
              </div>
            </div>
          ) : result ? (
            <InteractiveViewer result={result} />
          ) : (
            <div className="flex-1 border border-border rounded bg-card/50 flex flex-col items-center justify-center p-12 text-center relative shadow-lg">
              <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[length:20px_20px] pointer-events-none" />
              <Activity size={48} className="mb-6 opacity-20 text-primary" />
              <h3 className="text-lg font-mono uppercase tracking-widest text-slate-400 mb-2">Engine Idle</h3>
              <p className="max-w-sm text-sm text-slate-500 font-light">
                Configure material parameters and initialize the solver to compute RF propagation.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── InteractiveViewer ───────────────────────────────────────────────────────

function InteractiveViewer({ result }: { result: any }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startDrag = useRef({ x: 0, y: 0 });

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);

  // ROI state — null until the user draws and confirms
  const [confirmedRoi, setConfirmedRoi] = useState<Roi | null>(null);
  // ROI confirmation is a required pipeline step, so keep the selector visible
  // as soon as Stage 1 has produced a result.
  const [showRoiSelector, setShowRoiSelector] = useState(true);
  // Backend confirmation state — true only after crop_stage1_roi.py succeeds
  const [roiConfirmedOnBackend, setRoiConfirmedOnBackend] = useState(false);
  const [isConfirmingRoi, setIsConfirmingRoi] = useState(false);

  const { data: pastRuns } = useListStage1Runs();
  const { data: compareResult } = useGetStage1Run(compareRunId || "", {
    query: {
      enabled: !!compareRunId,
      queryKey: ["getStage1Run", compareRunId]
    }
  });

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const toggleCompare = () => {
    setCompareMode(!compareMode);
    if (compareMode) setCompareRunId(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!e.shiftKey && !e.ctrlKey) return;
    e.preventDefault();
    const zoomSensitivity = 0.005;
    setScale(prev => Math.min(Math.max(0.5, prev - e.deltaY * zoomSensitivity), 4));
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    isDragging.current = true;
    startDrag.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    setPosition({
      x: e.clientX - startDrag.current.x,
      y: e.clientY - startDrag.current.y
    });
  };

  const handlePointerUp = () => {
    setIsPanning(false);
    isDragging.current = false;
  };

  const resetView = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const downloadPNG = () => {
    const link = document.createElement('a');
    link.href = result.heatmapImageBase64;
    link.download = `SparkSquad_Run_${result.runId.substring(0,8)}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadPDF = () => {
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
    pdf.text(`ID: ${result.runId}`, W - margin, 9, { align: "right" });
    pdf.text(`${new Date(result.createdAt).toLocaleString()}`, W - margin, 14, { align: "right" });
    pdf.setDrawColor(255, 184, 0);
    pdf.setLineWidth(0.5);
    pdf.line(margin, 23, W - margin, 23);

    const imgY = 28;
    const imgH = 110;
    if (result.heatmapImageBase64) {
      const src = result.heatmapImageBase64.startsWith("data:") ? result.heatmapImageBase64 : `data:image/png;base64,${result.heatmapImageBase64}`;
      pdf.addImage(src, "PNG", margin, imgY, W - margin * 2, imgH, undefined, "FAST");
    }

    const statsY = imgY + imgH + 8;
    const colW = (W - margin * 2) / 3;
    const sections: [string, [string, string][]][] = [
      ["MATRIX SPECS", [
        ["Resolution", `${result.params.cellSizeMeters.toFixed(3)} m`],
        ["Grid Size", `${result.gridRows} × ${result.gridCols}`],
        ["Coverage", `${((result.occupiedFraction || 0) * 100).toFixed(1)}%`],
      ]],
      ["PHYSICS PARAMS", [
        ["Refractive Idx", String(result.params.refractiveIndex)],
        ["Absorption", String(result.params.absorptionCoeff)],
        ["Proxy Freq", `${result.params.frequencyMHz} MHz`],
      ]],
      ["SOURCE DATA", [
        ["Amplitude", `${result.params.sourceValue} V/m`],
        ["Grid Position", `${result.sourceX}, ${result.sourceY}`],
        ["Peak Signal", `${result.peakDb.toFixed(1)} dB`],
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
    pdf.text(`COMPUTE TIME: ${(result.executionTimeMs / 1000).toFixed(2)}s`, margin + 5, etY + 6.5);

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
    pdf.save(`SparkSquad_Report_${result.runId.substring(0, 8)}.pdf`);
  };

  const handleConfirmRoi = async (roi: Roi) => {
    setIsConfirmingRoi(true);
    try {
      const resp = await fetch(`/api/stage1/runs/${result.runId}/confirm-roi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(roi),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Failed to confirm ROI" }));
        throw new Error((err as any).error || "Failed to confirm ROI");
      }
      setConfirmedRoi(roi);
      setRoiConfirmedOnBackend(true);
      toast({
        title: "ROI Confirmed",
        description: `${roi.width}×${roi.height} px region locked in. Stage 2 is ready.`,
      });
    } catch (err) {
      toast({
        title: "ROI Confirmation Failed",
        description: err instanceof Error ? err.message : "Could not confirm ROI",
        variant: "destructive",
      });
    } finally {
      setIsConfirmingRoi(false);
    }
  };

  const handleResetRoi = () => {
    setConfirmedRoi(null);
    setRoiConfirmedOnBackend(false);
  };

  const handleLaunchStage2 = () => {
    // Stage 2 reads roi.json directly from the Stage 1 run dir on the server —
    // no ROI params needed in the URL.
    setLocation(`/simulator/stage-2?runId=${result.runId}`);
  };

  return (
    <div className={`flex-1 space-y-4 flex flex-col min-h-0 relative ${isFullscreen ? 'p-4 bg-background h-screen' : ''}`} ref={containerRef}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-mono text-white uppercase tracking-widest flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 glow-accent animate-pulse" /> Result Matrix
        </h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={toggleCompare} className={`h-8 text-[10px] uppercase tracking-wider font-mono border-border transition-colors ${compareMode ? 'bg-primary/20 text-primary border-primary/30' : 'bg-card hover:bg-secondary'}`}>
            <SplitSquareHorizontal size={14} className="mr-1.5" /> Compare
          </Button>
          <Button variant="outline" size="sm" onClick={downloadPNG} className="h-8 text-[10px] uppercase tracking-wider font-mono border-border bg-card hover:bg-secondary">
            <Download size={14} className="mr-1.5" /> PNG
          </Button>
          <Button variant="outline" size="sm" onClick={downloadPDF} className="h-8 text-[10px] uppercase tracking-wider font-mono border-border bg-card hover:bg-secondary text-primary hover:text-primary">
            <Download size={14} className="mr-1.5" /> PDF
          </Button>
          <Button variant="outline" size="sm" onClick={toggleFullscreen} className="h-8 text-[10px] uppercase tracking-wider font-mono border-border bg-card hover:bg-secondary">
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
        </div>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        <div 
          className="flex-1 border border-border rounded bg-black overflow-hidden relative group cursor-grab active:cursor-grabbing"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <div className="absolute top-4 left-4 z-10 flex gap-2">
            <div className="bg-background/80 backdrop-blur border border-white/10 rounded p-1.5 flex items-center gap-2 shadow-lg">
              <MousePointer2 size={14} className="text-slate-400" />
              <span className="text-[10px] font-mono text-slate-300">Scroll+Mod: Zoom | Drag: Pan</span>
            </div>
            {scale !== 1 && (
              <Button variant="secondary" size="icon" className="h-7 w-7 rounded bg-background/80 backdrop-blur border border-white/10 hover:bg-primary/20 text-primary" onClick={resetView}>
                <Maximize2 size={12} />
              </Button>
            )}
          </div>

          {result.wasSourceSnapped && (
            <div className="absolute top-4 right-4 z-10 bg-accent text-accent-foreground text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded shadow-[0_0_15px_rgba(255,184,0,0.4)] flex items-center gap-1.5 animate-in slide-in-from-top-2">
              <AlertCircle size={14} /> Auto-Snapped
            </div>
          )}
          
          <div className="absolute bottom-4 left-4 z-10 bg-black/60 backdrop-blur border border-white/10 px-2 py-1 rounded text-[10px] font-mono text-white/70">
            ID: {result.runId.substring(0,8)}
          </div>

          <div className="w-full h-full flex items-center justify-center">
            <img 
              src={result.heatmapImageBase64.startsWith('data:') ? result.heatmapImageBase64 : `data:image/png;base64,${result.heatmapImageBase64}`} 
              alt="RF Coverage Heatmap" 
              draggable={false}
              style={{ 
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                transformOrigin: "center center",
                transition: isPanning ? 'none' : 'transform 0.1s ease-out'
              }}
              className="max-w-full max-h-full object-contain pointer-events-none"
            />
          </div>
        </div>

        {compareMode && (
          <div className="flex-1 border border-border rounded bg-black overflow-hidden relative flex flex-col">
            <div className="absolute top-4 left-4 right-4 z-10 flex gap-2">
              <select 
                className="bg-background/80 backdrop-blur border border-white/10 rounded p-1.5 text-xs font-mono text-slate-300 shadow-lg outline-none w-full max-w-[200px]"
                value={compareRunId || ""}
                onChange={(e) => setCompareRunId(e.target.value)}
              >
                <option value="">Select run to compare...</option>
                {pastRuns?.filter(r => r.runId !== result.runId).map(r => (
                  <option key={r.runId} value={r.runId}>
                    Run {r.runId.substring(0, 8)} ({new Date(r.createdAt).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </div>
            
            {compareResult && (
              <div className="absolute bottom-4 left-4 z-10 bg-black/60 backdrop-blur border border-white/10 px-2 py-1 rounded text-[10px] font-mono text-white/70">
                ID: {compareResult.runId.substring(0,8)}
              </div>
            )}

            <div className="w-full h-full flex items-center justify-center pointer-events-none">
              {compareResult && compareResult.heatmapImageBase64 ? (
                <img 
                  src={compareResult.heatmapImageBase64.startsWith('data:') ? compareResult.heatmapImageBase64 : `data:image/png;base64,${compareResult.heatmapImageBase64}`} 
                  alt="Compared Heatmap" 
                  draggable={false}
                  style={{ 
                    transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                    transformOrigin: "center center",
                    transition: isPanning ? 'none' : 'transform 0.1s ease-out'
                  }}
                  className="max-w-full max-h-full object-contain"
                />
              ) : compareRunId ? (
                <Activity size={24} className="text-primary animate-pulse" />
              ) : (
                <span className="text-slate-500 font-mono text-xs uppercase tracking-widest">Awaiting Selection</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Diagnostics Readout */}
      {!isFullscreen && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            <StatBlock label="Run ID" value={result.runId.substring(0,8)} highlight />
            <StatBlock label="Grid Matrix" value={`${result.gridRows}×${result.gridCols}`} />
            <StatBlock label="Cell Res" value={`${result.params.cellSizeMeters.toFixed(3)}m`} />
            <StatBlock label="Compute Time" value={`${(result.executionTimeMs / 1000).toFixed(2)}s`} />
            <StatBlock label="Peak Signal" value={`${result.peakDb.toFixed(1)} dB`} highlight={false} color="text-accent" />
            <StatBlock label="Coverage Area" value={`${((result.occupiedFraction || 0) * 100).toFixed(1)}%`} />
          </div>

          {/* Step 2: ROI Selection — Required before Stage 2 */}
          <div className="border border-border rounded bg-card overflow-hidden">
            <button
              className="w-full flex items-center justify-between p-4 hover:bg-slate-800/50 transition-colors"
              onClick={() => setShowRoiSelector(v => !v)}
            >
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold ${roiConfirmedOnBackend ? 'border-green-500 bg-green-500/20 text-green-400' : 'border-amber-500 bg-amber-500/10 text-amber-400'}`}>
                  {roiConfirmedOnBackend ? <CheckCircle2 size={12} /> : "2"}
                </div>
                <span className="text-xs font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
                  <Crop size={13} className="text-primary" />
                  Confirm Heatmap ROI
                  {roiConfirmedOnBackend && confirmedRoi && (
                    <span className="text-[10px] font-mono text-green-400 normal-case tracking-normal">
                      {confirmedRoi.width}×{confirmedRoi.height} px ✓
                    </span>
                  )}
                  {!roiConfirmedOnBackend && (
                    <span className="text-[10px] font-mono text-amber-400 normal-case tracking-normal">required</span>
                  )}
                </span>
              </div>
              <span className="text-[10px] font-mono text-slate-500 uppercase">
                {showRoiSelector ? "▲ collapse" : roiConfirmedOnBackend ? "▼ change" : "▼ open"}
              </span>
            </button>

            {showRoiSelector && (
              <div className="p-4 border-t border-border">
                <RoiSelector
                  heatmapSrc={result.heatmapImageBase64}
                  onConfirm={handleConfirmRoi}
                  onReset={handleResetRoi}
                  existingRoi={confirmedRoi ?? undefined}
                  isConfirmed={roiConfirmedOnBackend}
                  isConfirming={isConfirmingRoi}
                />
              </div>
            )}
          </div>

          <div className="pt-2 flex justify-between items-center">
            <div className="text-[10px] font-mono text-slate-500">
              {roiConfirmedOnBackend && confirmedRoi
                ? `ROI confirmed — (${confirmedRoi.x}, ${confirmedRoi.y}) ${confirmedRoi.width}×${confirmedRoi.height} px — Stage 2 is ready`
                : "ROI required — draw a rectangle on the heatmap and click Confirm ROI before Stage 2"}
            </div>
            <motion.button 
              whileHover={roiConfirmedOnBackend ? { scale: 1.02 } : {}}
              whileTap={roiConfirmedOnBackend ? { scale: 0.98 } : {}}
              className={`flex items-center justify-center gap-2 px-4 rounded uppercase text-[10px] tracking-widest font-bold h-9 transition-all ${
                roiConfirmedOnBackend
                  ? "bg-primary text-white hover:bg-primary/90 glow-primary"
                  : "bg-slate-700 text-slate-400 cursor-not-allowed opacity-50"
              }`}
              onClick={roiConfirmedOnBackend ? handleLaunchStage2 : undefined}
              disabled={!roiConfirmedOnBackend}
            >
              Initialize Phase 02 <ArrowRight size={14} />
            </motion.button>
          </div>
        </>
      )}
    </div>
  );
}

function StatBlock({ label, value, highlight = false, color = "text-white" }: { label: string, value: string | number, highlight?: boolean, color?: string }) {
  return (
    <div className={`bg-card border ${highlight ? 'border-primary/30 bg-primary/5' : 'border-border'} rounded p-2 flex flex-col gap-1`}>
      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{label}</span>
      <span className={`font-mono text-xs ${highlight ? 'text-primary' : color}`}>{value}</span>
    </div>
  )
}
