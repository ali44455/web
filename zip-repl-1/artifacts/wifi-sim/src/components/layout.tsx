import { ReactNode, useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { 
  Activity, Settings2, Info, LayoutDashboard, Cpu, 
  CheckCircle2, Circle, MapPin, DollarSign, FileText,
  Signal, Radio, BarChart3
} from "lucide-react";
import logoUrl from "@/assets/spark-squad-logo.jpeg";
import IntroSequence from "./IntroSequence";
import AnimatedBackground from "./AnimatedBackground";
import { AnimatePresence, motion } from "framer-motion";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    const hasSeenIntro = sessionStorage.getItem("spark_squad_intro_seen");
    // Deep links into the simulator must remain actionable. The intro belongs
    // to the landing page and should never cover Stage 1's ROI controls.
    if (!hasSeenIntro && location === "/") {
      setShowIntro(true);
    }
  }, [location]);

  const handleIntroComplete = () => {
    sessionStorage.setItem("spark_squad_intro_seen", "true");
    setShowIntro(false);
  };

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/simulator", label: "Heatmap Generation", icon: Activity },
    { href: "/simulator/stage-2", label: "Node Placement", icon: MapPin },
    { href: "/simulator/stage-4", label: "Phased Array", icon: Radio },
    { href: "/simulator/stage-5", label: "Engineering Analysis", icon: BarChart3 },
    { href: "/simulator/stage-3", label: "Budget Optimization", icon: DollarSign },
    { href: "/reports", label: "Reports", icon: FileText },
    { href: "/guide", label: "Parameters Guide", icon: Settings2 },
    { href: "/about", label: "About Spark Squad", icon: Info },
  ];

  const workflowSteps = [
    { id: 1, label: "Upload Blueprint", isActive: (step: number) => step >= 1, isComplete: (step: number) => step >= 2 },
    { id: 2, label: "Heatmap", isActive: (step: number) => step >= 1, isComplete: (step: number) => step >= 2 },
    { id: 3, label: "Node Placement", isActive: (step: number) => step >= 2, isComplete: (step: number) => step >= 3 },
    { id: 4, label: "Phased Array", isActive: (step: number) => step >= 3, isComplete: (step: number) => step >= 4 },
    { id: 5, label: "Analysis", isActive: (step: number) => step >= 4, isComplete: (step: number) => step >= 5 },
    { id: 6, label: "Budget Opt.", isActive: (step: number) => step >= 5, isComplete: (step: number) => step >= 6 },
    { id: 7, label: "Report", isActive: (step: number) => step >= 6, isComplete: () => false },
  ];

  // Determine current step and stage name based on location — must be before any early return
  let currentStep = 0;
  let stageName = "Idle";
  if (location.startsWith("/simulator/stage-5")) {
    currentStep = 4; stageName = "Analysis";
  } else if (location.startsWith("/simulator/stage-4")) {
    currentStep = 3; stageName = "Phased Array";
  } else if (location.startsWith("/simulator/stage-3")) {
    currentStep = 5; stageName = "Budget Opt";
  } else if (location.startsWith("/simulator/stage-2")) {
    currentStep = 2; stageName = "Node Placement";
  } else if (location.startsWith("/simulator")) {
    currentStep = 1; stageName = "Heatmap";
  } else if (location.startsWith("/reports")) {
    currentStep = 6; stageName = "Report";
  } else if (location === "/") {
    stageName = "Dashboard";
  }

  // Update localStorage — must be before early return (Rules of Hooks)
  useEffect(() => {
    if (stageName !== "Idle" && stageName !== "Dashboard") {
      localStorage.setItem("spark_squad_last_stage", stageName);
    }
  }, [stageName]);

  if (showIntro) {
    return <IntroSequence onComplete={handleIntroComplete} />;
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-transparent text-foreground selection:bg-primary/30 relative">
      <AnimatedBackground />
      
      {/* Slim Top Bar */}
      <header className="h-14 border-b border-border bg-card/50 backdrop-blur-md flex items-center justify-between px-6 sticky top-0 z-40">
        <Link href="/" className="flex items-center gap-3 cursor-pointer group">
          <img src={logoUrl} alt="Spark Squad" className="w-8 h-8 rounded border border-white/10 group-hover:border-primary/50 transition-colors" />
          <div className="flex flex-col">
            <span className="text-xs font-bold tracking-widest uppercase text-white leading-none">Spark Squad</span>
            <span className="text-[10px] text-primary tracking-widest uppercase font-mono mt-1">RF Simulator</span>
          </div>
        </Link>

        <div className="hidden md:flex items-center gap-4 text-xs font-mono">
          <div className="flex items-center gap-2 px-3 py-1 rounded bg-secondary text-secondary-foreground border border-border">
            <Signal size={12} className="text-primary" />
            <span>FDFD Engine</span>
            <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded ml-2">ONLINE</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 rounded bg-secondary text-secondary-foreground border border-border">
            <Activity size={12} className="text-accent" />
            <span>Stage:</span>
            <span className="text-[10px] text-accent uppercase font-bold">{stageName}</span>
          </div>
        </div>
      </header>

      <div className="flex-1 flex flex-col md:flex-row w-full max-w-[1600px] mx-auto overflow-hidden z-10 relative">
        {/* Sidebar */}
        <aside className="w-full md:w-64 md:border-r border-border bg-card/30 backdrop-blur flex-shrink-0 flex flex-col overflow-y-auto hidden md:flex">
          <nav className="flex-1 px-4 py-6 space-y-1">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-4 px-3">Navigation</div>
            {navItems.map((item) => {
              // Active item detection
              let active = false;
              if (item.href === "/") {
                active = location === "/";
              } else if (item.href === "/simulator") {
                active = location === "/simulator" || location === "/simulator/stage-1";
              } else if (item.href === "/simulator/stage-2") {
                active = location.startsWith("/simulator/stage-2");
              } else if (item.href === "/simulator/stage-3") {
                active = location.startsWith("/simulator/stage-3");
              } else {
                active = location.startsWith(item.href);
              }

              return (
                <Link 
                  key={item.href} 
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded transition-all text-sm font-medium border
                    ${active 
                      ? "bg-primary/10 border-primary/20 text-primary glow-primary" 
                      : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
                >
                  <item.icon size={16} className={active ? "text-primary" : "opacity-70"} />
                  {item.label}
                </Link>
              );
            })}

            <div className="mt-8 mb-4 px-3 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Workflow</div>
            <div className="px-3 space-y-0">
              {workflowSteps.map((step, idx) => {
                const isActive = step.isActive(currentStep);
                const isComplete = step.isComplete(currentStep);
                const isCurrent = isActive && !isComplete;
                const isPast = isComplete;
                
                return (
                  <div key={step.id} className="relative flex items-start group">
                    {idx < workflowSteps.length - 1 && (
                      <div className={`absolute top-5 left-[7px] w-[1px] h-6 ${isPast ? 'bg-primary' : 'bg-border'}`} />
                    )}
                    <div className="flex items-center justify-center w-4 h-4 mt-0.5 z-10 bg-transparent">
                      {isPast ? (
                        <CheckCircle2 size={14} className="text-primary bg-background rounded-full" />
                      ) : isCurrent ? (
                        <div className="w-2.5 h-2.5 rounded-full bg-accent glow-accent animate-pulse" />
                      ) : (
                        <Circle size={14} className="text-muted bg-background rounded-full" />
                      )}
                    </div>
                    <div className={`ml-3 pb-4 text-xs font-mono ${isCurrent ? 'text-accent' : isPast ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {step.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </nav>

          <div className="p-4 border-t border-border mt-auto">
            <div className="text-[10px] text-muted-foreground text-center flex flex-col items-center gap-1 uppercase tracking-widest font-mono">
              <span className="text-slate-400">Powered by Spark Squad</span>
              <span>Faculty of Engineering</span>
              <span>Cairo University</span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 bg-transparent overflow-auto relative">
          <div className="p-4 md:p-8 lg:p-12 w-full">
            <AnimatePresence mode="wait">
              <motion.div 
                key={location} 
                initial={{ opacity: 0, y: 8 }} 
                animate={{ opacity: 1, y: 0 }} 
                exit={{ opacity: 0, y: -8 }} 
                transition={{ duration: 0.25 }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
          <footer className="md:hidden p-6 border-t border-border mt-auto text-center text-xs text-muted-foreground font-mono flex flex-col gap-1 uppercase tracking-widest">
            <span className="text-slate-400">Powered by Spark Squad</span>
            <span>Faculty of Engineering</span>
            <span>Cairo University</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
