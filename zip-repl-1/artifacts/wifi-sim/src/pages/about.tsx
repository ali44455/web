import { Link } from "wouter";
import { Info, ExternalLink, ShieldCheck, Target, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import logoUrl from "@/assets/spark-squad-logo.jpeg";

export default function About() {
  return (
    <div className="max-w-4xl space-y-12 animate-in fade-in duration-500 pb-20 mx-auto">
      <header className="space-y-6 text-center pt-8">
        <img src={logoUrl} alt="Spark Squad" className="w-32 h-32 mx-auto rounded-xl shadow-2xl border border-white/10 glow-primary" />
        <h1 className="text-4xl font-bold tracking-tight text-white uppercase text-glow-primary">System Architecture</h1>
        <p className="text-primary font-mono tracking-widest text-sm">CUFE SIMULATOR V0.1.0-BETA</p>
      </header>

      <div className="grid md:grid-cols-2 gap-8">
        <div className="space-y-6">
          <div className="bg-card border border-border rounded p-8">
            <h3 className="text-lg font-bold text-white uppercase tracking-widest mb-4 flex items-center gap-2">
              <Target className="text-primary" size={20} /> Mission
            </h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              The <strong>Spark Squad Coverage Simulator</strong> is an engineering tool constructed for network planners at Cairo University Faculty of Engineering (CUFE). It provides deterministic prediction of RF coverage before physical hardware deployment.
            </p>
          </div>

          <div className="bg-card border border-border rounded p-8">
            <h3 className="text-lg font-bold text-white uppercase tracking-widest mb-4 flex items-center gap-2">
              <Zap className="text-accent" size={20} /> Methodology
            </h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              Unlike standard empirical path-loss formulas (Okumura-Hata) that estimate signal decay by distance alone, this engine employs a <strong>Finite-Difference Frequency-Domain (FDFD)</strong> solver. It computes steady-state electromagnetic wave propagation across a discretized spatial grid, naturally accounting for physical reflection, refraction, and complex interference patterns.
            </p>
          </div>
        </div>

        <div className="bg-background/50 border border-primary/20 rounded p-8 flex flex-col h-full relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-5">
            <ShieldCheck size={120} />
          </div>
          <h3 className="text-lg font-bold text-white uppercase tracking-widest mb-6 flex items-center gap-2 text-glow-primary">
            <Info className="text-primary" size={20} /> Technical Constraints
          </h3>
          <p className="text-slate-400 text-xs mb-4 uppercase tracking-widest font-mono">Operator Awareness Required</p>
          
          <ul className="space-y-4 text-sm text-slate-300 flex-1 font-light">
            <li className="flex gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0 glow-primary" />
              <div>
                <strong className="text-white block mb-1">2D Approximation</strong>
                Solves Maxwell's equations in 2D space. 3D spherical spreading is emulated via the <code className="text-[10px] font-mono bg-card px-1 py-0.5 rounded border border-border text-primary">alpha3dBump</code> tuning variable.
              </div>
            </li>
            <li className="flex gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0 glow-primary" />
              <div>
                <strong className="text-white block mb-1">Proxy Frequencies</strong>
                To maintain feasible matrix sizes (sub-million cells), the engine runs at ~50 MHz proxy frequencies rather than literal 2.4/5 GHz.
              </div>
            </li>
            <li className="flex gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0 glow-primary" />
              <div>
                <strong className="text-white block mb-1">Material Homogeneity</strong>
                Imported blueprints are classified strictly as free-space or solid structure, assuming uniform dielectric properties across all walls.
              </div>
            </li>
          </ul>

          <div className="pt-8 border-t border-border mt-8">
            <Link href="/guide">
              <Button className="w-full bg-primary/10 text-primary border border-primary/30 hover:bg-primary hover:text-white uppercase tracking-widest text-xs h-10 rounded transition-all">
                Access Variable Guide <ExternalLink size={14} className="ml-2" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
