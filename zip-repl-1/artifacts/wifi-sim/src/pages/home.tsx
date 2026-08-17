import { useEffect, useState } from "react";
import { Link } from "wouter";
import { BookOpen, Info, Zap, Activity, Clock, Zap as ZapIcon, Maximize2, AlertCircle, CheckCircle2 } from "lucide-react";
import { motion, useSpring } from "framer-motion";
import { useHealthCheck, useListStage1Runs, useGetStage1Run } from "@workspace/api-client-react";

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, delay, ease: "easeOut" as const },
});

const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 }
  }
};

const staggerItem = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }
};

export default function Home() {
  const { data: healthData, isLoading: healthLoading, isError: healthError } = useHealthCheck();
  const { data: runs } = useListStage1Runs();
  
  const [currentStage, setCurrentStage] = useState("Idle");
  
  useEffect(() => {
    const stage = localStorage.getItem("spark_squad_last_stage") || "Idle";
    setCurrentStage(stage);
  }, []);

  const latestSummary = runs?.[0];

  // Fetch full detail for the latest run to get heatmap + params
  const { data: latestRun } = useGetStage1Run(latestSummary?.runId ?? "", {
    query: { enabled: !!latestSummary?.runId, queryKey: ["getStage1Run", latestSummary?.runId] }
  });

  return (
    <div className="relative min-h-[calc(100dvh-3.5rem)] flex flex-col px-4 py-8 overflow-hidden z-10 w-full">
      <div className="mb-10 w-full max-w-6xl mx-auto flex items-center justify-between">
        <motion.div {...fadeUp(0)}>
          <h1 className="text-3xl font-black tracking-[0.16em] uppercase text-white mb-2 font-sans flex items-center gap-4">
            Dashboard
            <span className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-2 py-1 rounded font-mono font-bold tracking-widest">Workspace</span>
          </h1>
          <p className="text-slate-400 text-sm font-mono tracking-widest uppercase">
            Overview & Metrics
          </p>
        </motion.div>

        <motion.div {...fadeUp(0.1)} className="hidden md:flex gap-3">
          <Link href="/simulator">
            <motion.button 
              whileHover={{ scale: 1.04, boxShadow: "0 0 24px rgba(0,163,255,0.4)" }} 
              whileTap={{ scale: 0.97 }}
              className="group flex items-center gap-2 px-6 py-2.5 bg-primary text-white text-[10px] font-bold tracking-[0.2em] uppercase rounded transition-all"
            >
              <Zap size={14} /> New Simulation
            </motion.button>
          </Link>
          <Link href="/guide">
            <motion.button 
              whileHover={{ scale: 1.02 }} 
              whileTap={{ scale: 0.98 }}
              className="flex items-center gap-2 px-6 py-2.5 bg-card border border-border text-slate-300 hover:text-white text-[10px] font-bold tracking-[0.2em] uppercase rounded transition-all"
            >
              <BookOpen size={14} /> Guide
            </motion.button>
          </Link>
          <Link href="/about">
            <motion.button 
              whileHover={{ scale: 1.02 }} 
              whileTap={{ scale: 0.98 }}
              className="flex items-center gap-2 px-6 py-2.5 bg-card border border-border text-slate-300 hover:text-white text-[10px] font-bold tracking-[0.2em] uppercase rounded transition-all"
            >
              <Info size={14} /> About
            </motion.button>
          </Link>
        </motion.div>
      </div>

      <motion.div 
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="w-full max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-6"
      >
        {/* Left Column */}
        <div className="md:col-span-8 flex flex-col gap-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            
            {/* Simulation Status Card */}
            <motion.div 
              variants={staggerItem}
              whileHover={{ y: -2, borderColor: "rgba(0,163,255,0.3)" }}
              className="bg-card/80 backdrop-blur border border-border rounded p-6 shadow-lg flex flex-col"
            >
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                <Activity size={14} /> Engine Status
              </h3>
              <div className="flex items-center gap-4 mt-auto">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${healthLoading ? 'bg-secondary' : healthError ? 'bg-destructive/20 text-destructive' : 'bg-green-500/20 text-green-500'}`}>
                  {healthLoading ? <Activity size={20} className="animate-pulse" /> : healthError ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
                </div>
                <div>
                  <div className="text-xl font-bold uppercase tracking-widest text-white">
                    {healthLoading ? "Connecting" : healthError ? "Offline" : "Online"}
                  </div>
                  <div className="text-xs font-mono text-slate-500 mt-1">FDFD compute module</div>
                </div>
              </div>
            </motion.div>

            {/* Current Stage Card */}
            <motion.div 
              variants={staggerItem}
              whileHover={{ y: -2, borderColor: "rgba(0,163,255,0.3)" }}
              className="bg-card/80 backdrop-blur border border-border rounded p-6 shadow-lg flex flex-col"
            >
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                <Maximize2 size={14} /> Active Phase
              </h3>
              <div className="flex items-center gap-4 mt-auto">
                <div className="w-12 h-12 rounded-full bg-accent/20 text-accent flex items-center justify-center">
                  <Activity size={20} />
                </div>
                <div>
                  <div className="text-xl font-bold uppercase tracking-widest text-white">
                    {currentStage}
                  </div>
                  <div className="text-xs font-mono text-slate-500 mt-1">Current workflow step</div>
                </div>
              </div>
            </motion.div>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Coverage %" value={latestRun ? ((latestRun.occupiedFraction || 0) * 100) : 0} suffix="%" delay={0.2} isPlaceholder={!latestRun} />
            <StatCard label="Grid Cells" value={latestRun ? (latestRun.gridRows * latestRun.gridCols) : 0} isPlaceholder={!latestRun} delay={0.25} />
            <StatCard label="Freq MHz" value={latestRun ? latestRun.params.frequencyMHz : 0} isPlaceholder={!latestRun} delay={0.3} />
            <StatCard label="Peak dB" value={latestRun ? latestRun.peakDb : 0} isPlaceholder={!latestRun} delay={0.35} />
          </div>

          {/* Latest Simulation Text Details */}
          <motion.div 
            variants={staggerItem}
            className="bg-card/80 backdrop-blur border border-border rounded p-6 shadow-lg flex flex-col"
          >
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
              <Clock size={14} /> Latest Execution
            </h3>
            {latestRun ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-[10px] uppercase text-slate-500 font-mono mb-1">Run ID</div>
                  <div className="text-sm text-white font-mono">{latestRun.runId.substring(0, 8)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-500 font-mono mb-1">Date</div>
                  <div className="text-sm text-white font-mono">{new Date(latestRun.createdAt).toLocaleDateString()}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-500 font-mono mb-1">Grid Size</div>
                  <div className="text-sm text-white font-mono">{latestRun.gridRows}×{latestRun.gridCols}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-500 font-mono mb-1">Compute Time</div>
                  <div className="text-sm text-white font-mono text-accent">{(latestRun.executionTimeMs / 1000).toFixed(2)}s</div>
                </div>
              </div>
            ) : (
              <div className="text-sm font-mono text-slate-500 py-2">No simulations recorded.</div>
            )}
          </motion.div>
        </div>

        {/* Right Column: Map Preview */}
        <div className="md:col-span-4 flex flex-col">
          <motion.div 
            variants={staggerItem}
            className="bg-card/80 backdrop-blur border border-border rounded flex flex-col flex-1 shadow-lg overflow-hidden"
          >
            <div className="p-4 border-b border-border bg-black/20">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <ZapIcon size={14} className="text-primary" /> Map Preview
              </h3>
            </div>
            <div className="flex-1 bg-black p-4 flex items-center justify-center min-h-[300px]">
              {latestRun && latestRun.heatmapImageBase64 ? (
                <img 
                  src={latestRun.heatmapImageBase64.startsWith('data:') ? latestRun.heatmapImageBase64 : `data:image/png;base64,${latestRun.heatmapImageBase64}`} 
                  alt="Heatmap Preview" 
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <div className="text-center text-slate-500 flex flex-col items-center gap-3">
                  <Activity size={32} className="opacity-20" />
                  <span className="text-[10px] uppercase tracking-widest font-mono">No Map Data</span>
                </div>
              )}
            </div>
            {latestRun && (
              <div className="p-4 border-t border-border bg-black/20">
                <Link href={`/simulator/stage-1?runId=${latestRun.runId}`}>
                  <motion.button 
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full py-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-[10px] font-bold uppercase tracking-widest rounded transition-colors"
                  >
                    Open in Viewer
                  </motion.button>
                </Link>
              </div>
            )}
          </motion.div>
        </div>
      </motion.div>
      
      {/* Mobile action buttons (visible only on small screens) */}
      <motion.div 
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
        className="md:hidden mt-8 flex flex-col gap-3 w-full max-w-6xl mx-auto"
      >
        <Link href="/simulator" className="w-full">
          <motion.button 
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            className="w-full py-3.5 bg-primary text-white text-[10px] font-bold tracking-[0.2em] uppercase rounded shadow-lg"
          >
            New Simulation
          </motion.button>
        </Link>
      </motion.div>
    </div>
  );
}

function StatCard({ label, value, suffix = "", isPlaceholder = false, delay }: { label: string, value: number, suffix?: string, isPlaceholder?: boolean, delay: number }) {
  const animatedValue = useSpring(0, { bounce: 0, duration: 1200 });
  const [displayValue, setDisplayValue] = useState("0");

  useEffect(() => {
    if (!isPlaceholder) {
      animatedValue.set(value);
    }
  }, [value, isPlaceholder, animatedValue]);

  useEffect(() => {
    return animatedValue.on("change", (latest) => {
      // Format number to 1 decimal if it's not an integer, otherwise 0
      const formatted = latest % 1 !== 0 ? latest.toFixed(1) : Math.round(latest).toString();
      setDisplayValue(formatted);
    });
  }, [animatedValue]);

  return (
    <motion.div
      variants={staggerItem}
      whileHover={{ y: -2, borderColor: "rgba(0,163,255,0.3)" }}
      className="bg-card/80 backdrop-blur border border-border rounded p-4 flex flex-col gap-1 shadow-md"
    >
      <div className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">{label}</div>
      <div className="text-xl font-mono text-white">
        {isPlaceholder ? "—" : <>{displayValue}<span className="text-sm text-slate-400 ml-0.5">{suffix}</span></>}
      </div>
    </motion.div>
  );
}
