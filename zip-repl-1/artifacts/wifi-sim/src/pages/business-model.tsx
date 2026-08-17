import { useMemo, useState } from "react";
import { ArrowLeft, Calculator, CircleDollarSign, Gauge, Zap } from "lucide-react";
import { Link } from "wouter";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AntennaType = {
  name: string;
  shortName: string;
  gainDbi: number;
  efficiency: number;
  towerCost: number;
  lossDb: number;
  color: string;
};

type Calculation = AntennaType & {
  antennaPowerMw: number;
  totalPowerMw: number;
  initialCost: number;
  energyCost: number;
  totalCost: number;
};

const antennaTypes: AntennaType[] = [
  { name: "Omnidirectional", shortName: "Omni", gainDbi: 8, efficiency: 77, towerCost: 60000, lossDb: 1.76, color: "#18a8ff" },
  { name: "Sector", shortName: "Sector", gainDbi: 18.5, efficiency: 75, towerCost: 75000, lossDb: 2.33, color: "#f5b83d" },
  { name: "Phased Array", shortName: "Phased", gainDbi: 25, efficiency: 56, towerCost: 95000, lossDb: 3.99, color: "#39d98a" },
];

const POWER_PRICE = 0.164;
const ANNUAL_GROWTH = 0.0376;
const YEARS = 10;
const HOURS_PER_YEAR = 8760;
const NODE_COST = 2;
const NODE_POWER_MW = 230;

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function compactMoney(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return money(value);
}

export default function BusinessModel() {
  const [nodes, setNodes] = useState(10);
  const [inputPowerDbm, setInputPowerDbm] = useState(50);

  const powerCostFactor = useMemo(
    () => POWER_PRICE * ((Math.pow(1 + ANNUAL_GROWTH, YEARS) - 1) / ANNUAL_GROWTH),
    [],
  );

  const calculations = useMemo<Calculation[]>(() => antennaTypes.map((antenna) => {
    const antennaPowerMw = Math.pow(10, (inputPowerDbm + antenna.lossDb - antenna.gainDbi) / 10);
    const totalPowerMw = NODE_POWER_MW * nodes + antennaPowerMw;
    const initialCost = NODE_COST * nodes + antenna.towerCost;
    const energyCost = (totalPowerMw / 1_000_000) * HOURS_PER_YEAR * powerCostFactor;
    return { ...antenna, antennaPowerMw, totalPowerMw, initialCost, energyCost, totalCost: initialCost + energyCost };
  }), [inputPowerDbm, nodes, powerCostFactor]);

  const lowestCost = Math.min(...calculations.map((item) => item.totalCost));
  const chartData = calculations.map((item) => ({ name: item.shortName, totalCost: Math.round(item.totalCost), energyCost: Math.round(item.energyCost) }));

  return (
    <div className="max-w-[1400px] mx-auto space-y-8 pb-20">
      <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-slate-500">
        <Link href="/" className="hover:text-slate-200 transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-primary">Business Model</span>
      </div>

      <header className="border-b border-border pb-6">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-primary mb-3"><CircleDollarSign size={14} /> Stage 06 • Cost Evaluation</div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Business Model</h1>
            <p className="text-slate-400 mt-3 max-w-2xl leading-relaxed">Compare the 10-year ownership cost, power demand, and efficiency trade-offs for the three antenna strategies.</p>
          </div>
          <Link href="/simulator/stage-5" className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-slate-400 hover:text-primary transition-colors"><ArrowLeft size={14} /> Engineering Analysis</Link>
        </div>
      </header>

      <section className="grid lg:grid-cols-[360px_1fr] gap-6">
        <div className="bg-card border border-border rounded p-6 space-y-6">
          <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-200"><Calculator size={17} className="text-primary" /> Scenario inputs</div>
          <div className="space-y-2">
            <Label htmlFor="nodes" className="text-[10px] font-mono uppercase tracking-widest text-slate-500">RSSI nodes</Label>
            <Input id="nodes" type="number" min={0} step={1} value={nodes} onChange={(event) => setNodes(Math.max(0, Number(event.target.value) || 0))} className="h-11 bg-background border-border font-mono text-lg" />
            <p className="text-[11px] text-slate-500">Each node costs $2 and consumes 230 mW.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="input-power" className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Antenna input power (dBm)</Label>
            <Input id="input-power" type="number" min={-100} max={100} step={1} value={inputPowerDbm} onChange={(event) => setInputPowerDbm(Number(event.target.value) || 0)} className="h-11 bg-background border-border font-mono text-lg" />
            <p className="text-[11px] text-slate-500">Used with each antenna’s gain and total loss to calculate transmitted power.</p>
          </div>
          <div className="border-t border-border pt-5 space-y-3 text-xs font-mono">
            <div className="flex justify-between"><span className="text-slate-500">Planning horizon</span><span className="text-slate-200">10 years</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Electricity price</span><span className="text-slate-200">$0.164 / kWh</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Annual price growth</span><span className="text-slate-200">3.76%</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Power-cost factor</span><span className="text-primary">{powerCostFactor.toFixed(3)}</span></div>
          </div>
        </div>

        <div className="bg-card border border-border rounded p-6 min-h-[330px]">
          <div className="flex items-center justify-between mb-4"><div><h2 className="text-sm font-bold uppercase tracking-widest text-slate-200">10-year cost comparison</h2><p className="text-xs text-slate-500 mt-1">Initial deployment plus projected energy cost.</p></div><Gauge size={20} className="text-accent" /></div>
          <ResponsiveContainer width="100%" height={270}>
            <BarChart data={chartData} margin={{ top: 10, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#26313b" vertical={false} />
              <XAxis dataKey="name" stroke="#83909d" tick={{ fill: "#b7c0c9", fontSize: 12 }} />
              <YAxis stroke="#83909d" tick={{ fill: "#b7c0c9", fontSize: 11 }} tickFormatter={(value: number) => compactMoney(value)} />
              <Tooltip formatter={(value: number) => money(value)} contentStyle={{ background: "#111820", border: "1px solid #30404d", color: "#fff" }} />
              <Bar dataKey="totalCost" name="Total cost" fill="#18a8ff" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="grid md:grid-cols-3 gap-4">
        {calculations.map((item) => (
          <article key={item.name} className={`bg-card border rounded p-5 space-y-5 transition-colors ${item.totalCost === lowestCost ? "border-primary/60 shadow-[0_0_24px_rgba(24,168,255,0.10)]" : "border-border"}`}>
            <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-widest font-mono" style={{ color: item.color }}>{item.shortName}</p><h2 className="text-lg font-bold text-white mt-1">{item.name}</h2></div>{item.totalCost === lowestCost && <span className="text-[9px] uppercase tracking-widest font-mono text-primary border border-primary/30 rounded px-2 py-1">Lowest cost</span>}</div>
            <div className="grid grid-cols-2 gap-2 text-xs"><Stat label="Gain" value={`${item.gainDbi} dBi`} /><Stat label="Efficiency" value={`${item.efficiency}%`} /><Stat label="Tower" value={money(item.towerCost)} /><Stat label="Loss" value={`${item.lossDb} dB`} /></div>
            <div className="border-t border-border pt-4 space-y-2 text-xs font-mono"><Row label="Antenna power" value={`${item.antennaPowerMw.toFixed(1)} mW`} /><Row label="Total power" value={`${item.totalPowerMw.toFixed(1)} mW`} /><Row label="Initial cost" value={money(item.initialCost)} /><Row label="10-year energy" value={money(item.energyCost)} accent /><Row label="Total cost" value={money(item.totalCost)} strong /></div>
          </article>
        ))}
      </section>

      <section className="bg-card border border-border rounded p-6 space-y-4">
        <div className="flex items-center gap-2"><Zap size={17} className="text-accent" /><h2 className="text-sm font-bold uppercase tracking-widest text-slate-200">Methodology</h2></div>
        <div className="grid md:grid-cols-3 gap-4 text-xs text-slate-400 leading-relaxed"><p><strong className="text-slate-200">Total power:</strong> 230 × nodes + 10<sup>(input power + loss − gain) / 10</sup> mW.</p><p><strong className="text-slate-200">Energy cost:</strong> total power / 10⁶ × 8,760 × 0.164 × ((1.0376¹⁰ − 1) / 0.0376).</p><p><strong className="text-slate-200">Total cost:</strong> 2 × nodes + tower cost + 10-year energy cost.</p></div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="bg-background/60 rounded p-3"><p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p><p className="text-sm font-mono text-slate-100 mt-1">{value}</p></div>;
}

function Row({ label, value, accent, strong }: { label: string; value: string; accent?: boolean; strong?: boolean }) {
  return <div className="flex justify-between gap-3"><span className="text-slate-500">{label}</span><span className={`${strong ? "text-base font-bold" : ""} ${accent ? "text-accent" : "text-slate-200"}`}>{value}</span></div>;
}
