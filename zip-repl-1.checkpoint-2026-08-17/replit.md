# CUFE WiFi Coverage Simulator

A professional WiFi signal propagation simulator for CUFE (Cairo University Faculty of Engineering). Simulates electromagnetic wave behavior through building layouts using a Finite-Difference Frequency-Domain (FDFD) solver.

## Architecture

**Monorepo** managed with pnpm workspaces.

| Package | Path | Role |
|---|---|---|
| `@workspace/wifi-sim` | `artifacts/wifi-sim` | React + Vite frontend |
| `@workspace/api-server` | `artifacts/api-server` | Express.js backend / orchestrator |
| `@workspace/api-spec` | `lib/api-spec` | OpenAPI 3.0 spec |
| `@workspace/api-client-react` | `lib/api-client-react` | Generated TanStack Query hooks (Orval) |
| `@workspace/api-zod` | `lib/api-zod` | Shared Zod validation schemas |
| `@workspace/db` | `lib/db` | Drizzle ORM + PostgreSQL setup |

**Python engines** live in `artifacts/api-server/engine/` — the Express server spawns them as subprocesses for heavy numerical work (NumPy, SciPy sparse FDFD, Matplotlib, OpenCV, scikit-image).

## Simulation Stages

- **Stage 0** — Pre-process a general/satellite map into a simulation-ready binary mask (AI-assisted)
- **Stage 1** — Run FDFD electromagnetic simulation given antenna parameters + map geometry
- **Stage 2** — Detect dead zones, optimize node placement
- **Stage 3** — Summary report generation

## How to Run

Both workflows start automatically:

- **Frontend** (`artifacts/wifi-sim: web`): `pnpm --filter @workspace/wifi-sim run dev`
- **API Server** (`artifacts/api-server: API Server`): `pnpm --filter @workspace/api-server run dev`

### Python Dependencies

Install once if missing:
```
pip install numpy scipy matplotlib opencv-python scikit-image
```

### Environment Variables / Secrets

| Variable | Required for | Notes |
|---|---|---|
| `SESSION_SECRET` | Express session | Already set as Replit secret |
| `DATABASE_URL` | Drizzle ORM | Only needed if using PostgreSQL persistence |

The core simulation flow uses the local filesystem (`artifacts/api-server/data/runs/`) — a database is not strictly required to run simulations.

## User Preferences

- Keep the existing project structure and stack — do not restructure or migrate.
