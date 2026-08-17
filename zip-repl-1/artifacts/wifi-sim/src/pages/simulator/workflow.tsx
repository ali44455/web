import { useLocation } from "wouter";
import { FileImage, Map as MapIcon, ArrowRight, CheckCircle2 } from "lucide-react";

export default function SimulatorWorkflow() {
  const [, setLocation] = useLocation();

  return (
    <div className="max-w-4xl space-y-8 pb-20 animate-in fade-in duration-500 mx-auto">
      <div className="border-b border-border pb-4">
        <h1 className="text-2xl font-bold text-foreground">Start a Simulation</h1>
        <p className="text-muted-foreground mt-1">
          Choose the workflow that matches your map. You decide — the simulator never guesses this for you.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <WorkflowCard
          icon={FileImage}
          title="Simulation Ready Map"
          description="My map is already in the simulator's native format — a clean floor-plan-style drawing, like the project's original demo maps."
          bullets={["No preprocessing needed", "Upload directly to Stage 1"]}
          cta="Upload Simulation Ready Map"
          onClick={() => setLocation("/simulator/stage-1")}
        />
        <WorkflowCard
          icon={MapIcon}
          title="General Map"
          description="My map is an AI-generated render, satellite/Google-Maps-style image, CAD drawing, or a colored campus layout."
          bullets={["Processed automatically in Stage 0", "Then continues to Stage 1"]}
          cta="Process General Map (Stage 0)"
          onClick={() => setLocation("/simulator/stage-0")}
        />
      </div>
    </div>
  );
}

function WorkflowCard({
  icon: Icon,
  title,
  description,
  bullets,
  cta,
  onClick,
}: {
  icon: any;
  title: string;
  description: string;
  bullets: string[];
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col h-full hover:border-primary/50 hover:shadow-md transition-all group"
    >
      <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary mb-4">
        <Icon size={24} />
      </div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground flex-1 mb-4">{description}</p>
      <ul className="space-y-1.5 mb-6">
        {bullets.map((b) => (
          <li key={b} className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 size={14} className="text-primary shrink-0" /> {b}
          </li>
        ))}
      </ul>
      <div className="mt-auto text-sm font-medium text-primary inline-flex items-center gap-1 group-hover:underline">
        {cta} <ArrowRight size={14} />
      </div>
    </button>
  );
}
