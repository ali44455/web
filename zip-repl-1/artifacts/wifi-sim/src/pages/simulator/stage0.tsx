import { useState } from "react";
import { useLocation } from "wouter";
import { useCreateStage0Run } from "@workspace/api-client-react";
import { UploadCloud, FileImage, ChevronRight, Loader2, ArrowRight, ArrowLeft, Layers, Building2, Route as RoadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export default function Stage0() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);

  const createStage0 = useCreateStage0Run();
  const result = createStage0.data;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      createStage0.reset();
    }
  };

  const handleProcess = () => {
    if (!file) {
      toast({
        title: "Missing map image",
        description: "Please upload a general map image to process.",
        variant: "destructive",
      });
      return;
    }
    createStage0.mutate({ data: { map: file } }, {
      onError: (err) => {
        toast({
          title: "Map Processing Failed",
          description: err.data?.error || "An error occurred while processing the map.",
          variant: "destructive",
        });
      },
    });
  };

  const isProcessing = createStage0.isPending;

  return (
    <div className="max-w-6xl space-y-6 pb-20 animate-in fade-in duration-500">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
        <button onClick={() => setLocation("/simulator")} className="hover:text-foreground transition-colors flex items-center gap-1">
          <ArrowLeft size={14} /> Workflow
        </button>
        <ChevronRight size={16} />
        <span className="text-foreground">Stage 0: Map Processing</span>
        <ChevronRight size={16} />
        <span className="opacity-50">Stage 1: Heatmap</span>
      </div>

      <div className="border-b border-border pb-4">
        <h1 className="text-2xl font-bold text-foreground">Stage 0 — Map Processing</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl">
          Upload any campus map — AI-generated, satellite/Google-Maps-style, CAD, or a colored campus layout. This
          runs fully automatically: no parameters to tune. It converts your map into the simulator's standard
          format (Processed Map + Binary Mask) while preserving the exact building/road geometry, so Stage 1 can
          run its physics directly against it.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-card border border-border rounded-xl shadow-sm p-5 space-y-4">
            <div className="border-2 border-dashed border-border rounded-lg p-6 text-center hover:bg-muted/50 transition-colors relative">
              <input
                type="file"
                id="stage0-map-upload"
                accept="image/*"
                onChange={handleFileChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <div className="flex flex-col items-center gap-2 text-muted-foreground pointer-events-none">
                {file ? (
                  <>
                    <FileImage size={28} className="text-primary" />
                    <span className="text-sm font-medium text-foreground">{file.name}</span>
                    <span className="text-xs">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                  </>
                ) : (
                  <>
                    <UploadCloud size={28} />
                    <span className="text-sm font-medium">Click or drag a general map image</span>
                    <span className="text-xs">PNG, JPG up to 25MB</span>
                  </>
                )}
              </div>
            </div>

            <Button
              type="button"
              className="w-full gap-2 font-semibold"
              disabled={isProcessing || !file}
              onClick={handleProcess}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="animate-spin" size={18} />
                  Processing Map...
                </>
              ) : (
                <>
                  <Layers size={18} />
                  Process Map
                </>
              )}
            </Button>
          </div>

          {result && (
            <div className="grid grid-cols-3 gap-3">
              <StatCard icon={Building2} label="Buildings" value={`${(result.metadata.buildingCoverageFraction * 100).toFixed(1)}%`} />
              <StatCard icon={RoadIcon} label="Roads" value={`${(result.metadata.roadCoverageFraction * 100).toFixed(1)}%`} />
              <StatCard icon={Layers} label="Open Ground" value={`${(result.metadata.openAreaFraction * 100).toFixed(1)}%`} />
            </div>
          )}

          {result && (
            <Button
              size="lg"
              className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-lg"
              onClick={() => setLocation(`/simulator/stage-1?stage0RunId=${result.runId}`)}
            >
              Continue to Stage 1 <ArrowRight size={18} />
            </Button>
          )}
        </div>

        <div className="lg:col-span-7 space-y-4">
          {isProcessing ? (
            <div className="border border-border rounded-xl bg-card flex flex-col items-center justify-center p-12 text-center space-y-6 min-h-[400px]">
              <div className="relative w-24 h-24">
                <div className="absolute inset-0 border-4 border-muted rounded-full"></div>
                <div className="absolute inset-0 border-4 border-primary rounded-full border-t-transparent animate-spin"></div>
                <Layers className="absolute inset-0 m-auto text-primary animate-pulse" size={32} />
              </div>
              <div className="space-y-2 max-w-sm">
                <h3 className="text-lg font-semibold">Detecting Buildings & Roads</h3>
                <p className="text-sm text-muted-foreground">
                  Denoising, segmenting, and cleaning up the map into a standardized processed map and mask.
                </p>
              </div>
            </div>
          ) : result ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MapPreview title="Processed Map" src={result.processedMapImageBase64} />
              <MapPreview title="Binary Mask" src={result.binaryMaskImageBase64} />
            </div>
          ) : (
            <div className="border border-border border-dashed rounded-xl flex flex-col items-center justify-center p-12 text-center text-muted-foreground bg-muted/10 min-h-[400px]">
              <Layers size={48} className="mb-4 opacity-20" />
              <p className="max-w-xs">Upload a map and click "Process Map" to generate a standardized Processed Map and Binary Mask.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MapPreview({ title, src }: { title: string; src: string }) {
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="bg-slate-900 p-2 text-xs font-mono text-slate-300 px-3">{title}</div>
      <div className="bg-white p-2">
        <img src={src} alt={title} className="w-full h-auto object-contain" />
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 flex flex-col gap-1 items-center text-center">
      <Icon size={16} className="text-primary" />
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="font-mono font-semibold text-foreground text-sm">{value}</span>
    </div>
  );
}
