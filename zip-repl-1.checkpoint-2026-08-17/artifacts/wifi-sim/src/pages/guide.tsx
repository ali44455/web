import { Scaling, Zap, Signal, Settings } from "lucide-react";

export default function Guide() {
  return (
    <div className="max-w-5xl space-y-12 animate-in fade-in duration-500 pb-20 mx-auto">
      <header className="space-y-4 border-l-2 border-accent pl-6 py-2">
        <h1 className="text-4xl font-bold tracking-tight text-white uppercase text-glow-accent">Variable Reference</h1>
        <p className="text-slate-400 text-lg font-light">
          Technical specifications for engine input parameters and physical constants.
        </p>
      </header>

      <section className="space-y-6">
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <div className="p-2 bg-primary/10 rounded border border-primary/20">
            <Scaling className="text-primary" size={20} />
          </div>
          <h2 className="text-lg font-bold text-white uppercase tracking-widest">Matrix Geometry</h2>
        </div>
        
        <div className="grid md:grid-cols-2 gap-4">
          <ParamCard 
            name="cellSizeMeters"
            def="0.5"
            desc="Physical resolution of a single finite-difference grid cell (h). Overridden if realWidthMeters dictates otherwise."
          />
          <ParamCard 
            name="realWidthMeters"
            def="Auto"
            desc="True physical width of the blueprint. When set, calibrates cellSizeMeters automatically based on image aspect ratio."
          />
          <ParamCard 
            name="cellBudget"
            def="260,000"
            desc="Maximum allowable elements in the computational matrix. Constrains solve-time and memory allocation."
          />
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <div className="p-2 bg-accent/10 rounded border border-accent/20">
            <Zap className="text-accent" size={20} />
          </div>
          <h2 className="text-lg font-bold text-white uppercase tracking-widest">Dielectric Physics</h2>
        </div>
        
        <div className="grid md:grid-cols-2 gap-4">
          <ParamCard 
            name="frequencyMHz"
            def="50"
            desc="Proxy frequency. Values near 50-100MHz are required to satisfy Nyquist limits without exceeding cell budgets."
          />
          <ParamCard 
            name="refractiveIndex"
            def="2.0"
            desc="Index of refraction for solid pixels. Governs wave velocity reduction and boundary reflection intensity."
          />
          <ParamCard 
            name="absorptionCoeff"
            def="0.062"
            desc="Rate of signal attenuation (alpha) within structures. Higher values create pronounced dead-zones behind walls."
          />
          <ParamCard 
            name="alpha3dBump"
            def="0.0"
            desc="Artificial uniform attenuation injected to simulate 3D free-space propagation loss in the 2D solver."
          />
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <div className="p-2 bg-green-500/10 rounded border border-green-500/20">
            <Signal className="text-green-500" size={20} />
          </div>
          <h2 className="text-lg font-bold text-white uppercase tracking-widest">Source & Boundaries</h2>
        </div>
        
        <div className="grid md:grid-cols-2 gap-4">
          <ParamCard 
            name="sourceValue"
            def="22"
            desc="Base electric field amplitude injected at the TX coordinates. Scales the final dBm output."
          />
          <ParamCard 
            name="sourceX / Y (%)"
            def="10 / 5"
            desc="Normalized transmit coordinates. The engine will auto-snap these to the nearest open space if placed in a wall."
          />
          <ParamCard 
            name="pmlWidth"
            def="20"
            desc="Depth of the Perfectly Matched Layer. Thicker layers prevent artificial reflections off the grid edges."
          />
          <ParamCard 
            name="pmlMaxLoss"
            def="0.5"
            desc="Maximum attenuation factor at the extreme edge of the PML absorbing boundary."
          />
        </div>
      </section>
    </div>
  );
}

function ParamCard({ name, def, desc }: { name: string, def: string, desc: string }) {
  return (
    <div className="bg-card border border-border p-5 rounded hover:border-slate-700 transition-colors flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <code className="text-xs font-mono font-bold text-primary bg-primary/10 px-2 py-1 rounded border border-primary/20">{name}</code>
        <span className="text-[10px] uppercase tracking-widest text-slate-500 font-mono">Def: {def}</span>
      </div>
      <p className="text-sm text-slate-400 leading-relaxed font-light mt-auto">
        {desc}
      </p>
    </div>
  )
}