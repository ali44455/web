import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import logoUrl from "@/assets/spark-squad-logo.jpeg";

// --- Types ---
interface Node { x: number; y: number; lit: boolean; id: number }
interface Edge { a: number; b: number }

// Deterministic pseudo-random for SSR-safe seeding
function seededRand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return ((s >>> 0) / 0xffffffff);
  };
}

// Generate a sparse network of nodes
function makeNetwork(count: number, w: number, h: number): { nodes: Node[]; edges: Edge[] } {
  const rand = seededRand(42);
  const margin = 60;
  const nodes: Node[] = Array.from({ length: count }, (_, i) => ({
    id: i,
    x: margin + rand() * (w - margin * 2),
    y: margin + rand() * (h - margin * 2),
    lit: false,
  }));
  // Connect nearby nodes (Euclidean < threshold)
  const edges: Edge[] = [];
  const threshold = Math.min(w, h) * 0.28;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) {
        edges.push({ a: i, b: j });
      }
    }
  }
  return { nodes, edges };
}

// --- Heatmap gradient stops (blue → green → yellow → orange → red) ---
const HEATMAP_STOPS = [
  { offset: "0%",   color: "#1a1aff" },
  { offset: "25%",  color: "#00c8ff" },
  { offset: "45%",  color: "#00ff80" },
  { offset: "60%",  color: "#ffff00" },
  { offset: "75%",  color: "#ff8000" },
  { offset: "100%", color: "#ff0000" },
];

// ----------------------------------------------------------------
// Scenes
// ----------------------------------------------------------------
//  0 → black fade-in
//  1 → particles appear          (0.5s)
//  2 → computational grid forms  (0.5→2.0s)
//  3 → network nodes connect     (2.0→3.4s)
//  4 → RF waves pulse            (3.4→4.5s)
//  5 → grid zooms / city map     (4.5→5.4s)
//  6 → heatmap wipe              (5.4→6.3s)
//  7 → logo assembles            (6.3→7.2s)
//  8 → title text + button       (7.2s→)
// ----------------------------------------------------------------

export default function IntroSequence({ onComplete }: { onComplete: () => void }) {
  const [scene, setScene] = useState(0);
  const [litNodes, setLitNodes] = useState<number[]>([]);
  const [heatmapProgress, setHeatmapProgress] = useState(0); // 0→1
  const [wavePhase, setWavePhase] = useState(0);
  const waveRef = useRef<number | null>(null);
  const heatRef = useRef<number | null>(null);
  const litRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const W = 800;
  const H = 480;
  const { nodes, edges } = makeNetwork(22, W, H);

  // Scene clock
  useEffect(() => {
    const timers = [
      setTimeout(() => setScene(1), 500),
      setTimeout(() => setScene(2), 900),
      setTimeout(() => setScene(3), 2200),
      setTimeout(() => setScene(4), 3500),
      setTimeout(() => setScene(5), 4600),
      setTimeout(() => setScene(6), 5400),
      setTimeout(() => setScene(7), 6300),
      setTimeout(() => setScene(8), 7200),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // Light up nodes sequentially in scene 3
  useEffect(() => {
    if (scene !== 3) return;
    litRef.current.forEach(clearTimeout);
    litRef.current = nodes.map((n, i) =>
      setTimeout(() => setLitNodes(prev => [...prev, n.id]), i * 60)
    );
    return () => litRef.current.forEach(clearTimeout);
  }, [scene]);

  // RF wave animation in scene 4
  useEffect(() => {
    if (scene < 4 || scene > 6) {
      if (waveRef.current) cancelAnimationFrame(waveRef.current);
      return;
    }
    let start: number | null = null;
    const tick = (ts: number) => {
      if (!start) start = ts;
      setWavePhase((ts - start) / 800); // cycles every 0.8s
      waveRef.current = requestAnimationFrame(tick);
    };
    waveRef.current = requestAnimationFrame(tick);
    return () => { if (waveRef.current) cancelAnimationFrame(waveRef.current); };
  }, [scene]);

  // Heatmap wipe in scene 6
  useEffect(() => {
    if (scene !== 6) return;
    let start: number | null = null;
    const dur = 900;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      setHeatmapProgress(p);
      if (p < 1) heatRef.current = requestAnimationFrame(tick);
    };
    heatRef.current = requestAnimationFrame(tick);
    return () => { if (heatRef.current) cancelAnimationFrame(heatRef.current); };
  }, [scene]);

  const skip = useCallback(() => onComplete(), [onComplete]);

  // RF wave rings centered on random lit nodes for visual variety
  const waveNodes = nodes.filter((_, i) => i % 4 === 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#070910] overflow-hidden select-none cursor-pointer"
      onClick={scene >= 8 ? undefined : skip}
    >
      {/* Skip hint */}
      {scene < 8 && (
        <div className="absolute top-4 right-6 text-[11px] font-mono text-white/20 uppercase tracking-widest pointer-events-none">
          tap to skip
        </div>
      )}

      {/* ─── SVG stage: scenes 1–6 ─── */}
      <AnimatePresence>
        {scene >= 1 && scene <= 6 && (
          <motion.svg
            key="svg-stage"
            viewBox={`0 0 ${W} ${H}`}
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="xMidYMid slice"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, scale: scene >= 5 ? 1.18 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
          >
            <defs>
              {/* Heatmap gradient */}
              <linearGradient id="heatGrad" x1="0" y1="0" x2="0" y2="1">
                {HEATMAP_STOPS.map(s => (
                  <stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity="0.72" />
                ))}
              </linearGradient>
              {/* Glow filter */}
              <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="glowStrong" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* ── Scene 1: Ambient particles ── */}
            {scene >= 1 && Array.from({ length: 40 }, (_, i) => {
              const r = seededRand(i * 7 + 1);
              return (
                <motion.circle
                  key={`p${i}`}
                  cx={r() * W}
                  cy={r() * H}
                  r={r() * 1.5 + 0.5}
                  fill={i % 3 === 0 ? "#ffb800" : "#00a3ff"}
                  opacity={0}
                  animate={{ opacity: [0, r() * 0.6 + 0.1, 0] }}
                  transition={{ duration: r() * 2 + 2, delay: r() * 1.5, repeat: Infinity }}
                />
              );
            })}

            {/* ── Scene 2: Computational grid ── */}
            {scene >= 2 && (() => {
              const step = 40;
              const cols = Math.ceil(W / step);
              const rows = Math.ceil(H / step);
              return (
                <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2 }}>
                  {Array.from({ length: cols + 1 }, (_, i) => (
                    <motion.line
                      key={`gc${i}`}
                      x1={i * step} y1={0} x2={i * step} y2={H}
                      stroke="rgba(0,163,255,0.08)" strokeWidth="0.5"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
                      transition={{ duration: 1.0, delay: i * 0.015 }}
                    />
                  ))}
                  {Array.from({ length: rows + 1 }, (_, i) => (
                    <motion.line
                      key={`gr${i}`}
                      x1={0} y1={i * step} x2={W} y2={i * step}
                      stroke="rgba(0,163,255,0.08)" strokeWidth="0.5"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
                      transition={{ duration: 1.0, delay: i * 0.02 }}
                    />
                  ))}
                </motion.g>
              );
            })()}

            {/* ── Scene 3: Edges ── */}
            {scene >= 3 && edges.map((e, i) => {
              const na = nodes[e.a], nb = nodes[e.b];
              const lit = litNodes.includes(e.a) && litNodes.includes(e.b);
              return (
                <motion.line
                  key={`e${i}`}
                  x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                  stroke={lit ? "rgba(0,163,255,0.5)" : "rgba(0,163,255,0.08)"}
                  strokeWidth={lit ? 0.8 : 0.5}
                  filter={lit ? "url(#glow)" : undefined}
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.6, delay: i * 0.03 }}
                />
              );
            })}

            {/* ── Scene 3: Nodes ── */}
            {scene >= 3 && nodes.map((n) => {
              const lit = litNodes.includes(n.id);
              return (
                <motion.circle
                  key={`n${n.id}`}
                  cx={n.x} cy={n.y} r={lit ? 4 : 2.5}
                  fill={lit ? "#00a3ff" : "rgba(0,163,255,0.3)"}
                  filter={lit ? "url(#glowStrong)" : undefined}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20, delay: n.id * 0.055 }}
                />
              );
            })}

            {/* ── Scene 4: RF wave rings from nodes ── */}
            {scene >= 4 && waveNodes.map((n, i) => {
              const phase = ((wavePhase + i * 0.4) % 1);
              const r = phase * 90;
              const opacity = (1 - phase) * 0.5;
              return (
                <circle
                  key={`w${n.id}`}
                  cx={n.x} cy={n.y}
                  r={r}
                  fill="none"
                  stroke="#00a3ff"
                  strokeWidth={1.5}
                  opacity={opacity}
                />
              );
            })}

            {/* ── Scene 6: Heatmap wipe overlay ── */}
            {scene >= 6 && (
              <motion.rect
                x={0} y={0}
                width={W * heatmapProgress}
                height={H}
                fill="url(#heatGrad)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.7 }}
                transition={{ duration: 0.3 }}
              />
            )}

            {/* Heatmap contour simulation lines */}
            {scene >= 6 && heatmapProgress > 0.3 && (
              <motion.g initial={{ opacity: 0 }} animate={{ opacity: 0.3 }} transition={{ duration: 0.5 }}>
                {[120, 200, 300, 400].map(cx => (
                  <ellipse key={cx} cx={cx} cy={H * 0.5} rx={70} ry={45}
                    fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
                ))}
              </motion.g>
            )}
          </motion.svg>
        )}
      </AnimatePresence>

      {/* ─── Scene 7: Logo assembles ─── */}
      <AnimatePresence>
        {scene >= 7 && (
          <motion.div
            key="logo"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: scene >= 8 ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
          >
            {/* Golden pulse ring */}
            <motion.div
              className="absolute rounded-full border border-[#ffb800]/60"
              initial={{ width: 160, height: 160, opacity: 0 }}
              animate={{ width: [160, 380, 600], height: [160, 380, 600], opacity: [0.8, 0.3, 0] }}
              transition={{ duration: 1.4, ease: "easeOut" }}
              style={{ translateX: "-50%", translateY: "-50%", left: "50%", top: "50%" }}
            />
            {/* Wireless ripple */}
            {[0, 0.25, 0.5].map(delay => (
              <motion.div
                key={delay}
                className="absolute rounded-full border border-[#00a3ff]/40"
                initial={{ width: 200, height: 200, opacity: 0 }}
                animate={{ width: [200, 500], height: [200, 500], opacity: [0.6, 0] }}
                transition={{ duration: 1.2, delay, ease: "easeOut" }}
                style={{ translateX: "-50%", translateY: "-50%", left: "50%", top: "50%" }}
              />
            ))}
            <motion.img
              src={logoUrl}
              alt="Spark Squad"
              className="w-56 h-56 md:w-72 md:h-72 object-contain rounded-2xl relative z-10"
              initial={{ scale: 0.4, opacity: 0, filter: "blur(20px)" }}
              animate={{ scale: 1, opacity: 1, filter: "blur(0px)" }}
              transition={{ duration: 1.0, ease: "easeOut" }}
            />
            {/* Golden glow behind logo */}
            <div className="absolute w-48 h-48 rounded-full bg-[#ffb800]/20 blur-[60px] pointer-events-none" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Scene 8: Final title + Enter button ─── */}
      <AnimatePresence>
        {scene >= 8 && (
          <motion.div
            key="title"
            className="relative z-10 flex flex-col items-center text-center px-6 max-w-2xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.0 }}
          >
            {/* Small logo in corner of final screen */}
            <motion.img
              src={logoUrl}
              alt="Spark Squad"
              className="w-24 h-24 md:w-32 md:h-32 object-contain rounded-xl mb-6 opacity-90"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.1 }}
            />

            <motion.h1
              className="text-4xl md:text-6xl font-black tracking-[0.18em] uppercase text-white mb-2"
              style={{ fontFamily: "'Space Grotesk', 'Plus Jakarta Sans', sans-serif" }}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
            >
              SPARK SQUAD
            </motion.h1>

            <motion.p
              className="text-[#00a3ff] text-sm md:text-base font-mono tracking-[0.22em] uppercase mb-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.4 }}
            >
              RF Coverage Planner
            </motion.p>

            <motion.p
              className="text-white/40 text-xs md:text-sm tracking-widest mb-10"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.55 }}
            >
              Professional Wireless Network Planning Platform
            </motion.p>

            {/* Gold divider */}
            <motion.div
              className="w-16 h-px bg-[#ffb800] mb-10"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.5, delay: 0.6 }}
            />

            <motion.button
              onClick={onComplete}
              className="group relative px-10 py-3.5 bg-transparent border border-[#00a3ff] text-[#00a3ff] text-xs font-bold tracking-[0.3em] uppercase rounded overflow-hidden transition-all hover:text-white"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.8 }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
            >
              {/* Fill on hover */}
              <span className="absolute inset-0 bg-[#00a3ff] translate-x-[-101%] group-hover:translate-x-0 transition-transform duration-300 ease-out" />
              <span className="relative z-10">ENTER SIMULATOR</span>
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Persistent subtle vignette */}
      <div className="pointer-events-none absolute inset-0 bg-radial-[ellipse_at_center] from-transparent to-black/60" />
    </div>
  );
}
