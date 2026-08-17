import { memo } from "react";

const AnimatedBackground = memo(() => {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden bg-[#070910]">
      {/* Faint static grid */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.04]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="bg-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#00a3ff" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#bg-grid)" />
      </svg>

      {/* Drifting particles */}
      <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <style>
          {`
            @keyframes drift1 { 0% { transform: translate(0, 0); } 50% { transform: translate(50px, -30px); } 100% { transform: translate(0, 0); } }
            @keyframes drift2 { 0% { transform: translate(0, 0); } 50% { transform: translate(-40px, 40px); } 100% { transform: translate(0, 0); } }
            @keyframes drift3 { 0% { transform: translate(0, 0); } 50% { transform: translate(30px, 50px); } 100% { transform: translate(0, 0); } }
            @keyframes drift4 { 0% { transform: translate(0, 0); } 50% { transform: translate(-50px, -50px); } 100% { transform: translate(0, 0); } }
            @keyframes pulse-ring { 0% { r: 0; opacity: 0.5; stroke-width: 2px; } 100% { r: 300px; opacity: 0; stroke-width: 0.5px; } }
          `}
        </style>
        
        {/* Particles */}
        <circle cx="10%" cy="20%" r="1.5" fill="#00a3ff" style={{ animation: "drift1 20s ease-in-out infinite" }} opacity="0.6" />
        <circle cx="85%" cy="15%" r="1" fill="#00a3ff" style={{ animation: "drift2 25s ease-in-out infinite" }} opacity="0.5" />
        <circle cx="70%" cy="80%" r="2" fill="#00a3ff" style={{ animation: "drift3 22s ease-in-out infinite" }} opacity="0.4" />
        <circle cx="20%" cy="75%" r="1" fill="#00a3ff" style={{ animation: "drift4 18s ease-in-out infinite" }} opacity="0.7" />
        <circle cx="50%" cy="50%" r="1.5" fill="#00a3ff" style={{ animation: "drift1 24s ease-in-out infinite reverse" }} opacity="0.5" />
        <circle cx="35%" cy="40%" r="1" fill="#00a3ff" style={{ animation: "drift2 19s ease-in-out infinite reverse" }} opacity="0.6" />
        <circle cx="80%" cy="45%" r="1" fill="#00a3ff" style={{ animation: "drift3 21s ease-in-out infinite reverse" }} opacity="0.4" />
        <circle cx="60%" cy="90%" r="1.5" fill="#00a3ff" style={{ animation: "drift4 26s ease-in-out infinite reverse" }} opacity="0.5" />
        <circle cx="15%" cy="90%" r="1" fill="#00a3ff" style={{ animation: "drift1 23s ease-in-out infinite" }} opacity="0.6" />
        <circle cx="95%" cy="60%" r="2" fill="#00a3ff" style={{ animation: "drift2 27s ease-in-out infinite" }} opacity="0.3" />
        <circle cx="40%" cy="10%" r="1" fill="#00a3ff" style={{ animation: "drift3 17s ease-in-out infinite" }} opacity="0.5" />
        <circle cx="5%" cy="50%" r="1.5" fill="#00a3ff" style={{ animation: "drift4 28s ease-in-out infinite" }} opacity="0.4" />

        {/* Pulse rings */}
        <circle cx="30%" cy="30%" fill="none" stroke="#00a3ff" style={{ animation: "pulse-ring 12s linear infinite" }} />
        <circle cx="70%" cy="70%" fill="none" stroke="#00a3ff" style={{ animation: "pulse-ring 10s linear infinite 4s" }} />
        <circle cx="50%" cy="50%" fill="none" stroke="#00a3ff" style={{ animation: "pulse-ring 14s linear infinite 8s" }} />
      </svg>
    </div>
  );
});

AnimatedBackground.displayName = "AnimatedBackground";

export default AnimatedBackground;
