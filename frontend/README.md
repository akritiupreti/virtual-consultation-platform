# Frontend

React + TypeScript (Vite) client for the Virtual Consultation Platform.

Phase 2 ships the **MVP screens** for the vertical slice:

- **Login / Register** — JWT auth; registration always creates a patient.
- **Patient** (`/patient`) — submit an intake request, see live queue position, open the
  consultation room, read the finalized summary.
- **Triage queue** (`/queue`, clinicians) — minimal pre-claim view, claim a case, re-prioritize.
- **Consultation room** (`/consultations/:id`) — intake, persisted messaging, start/complete,
  draft summary; doctors finalize.
- **Summary** (`/consultations/:id/summary`) — view (and, for doctors, finalize) the summary.
- **Audit log** (`/audit`, admins) — system activity only, no clinical content.

Real-time updates arrive in Phase 3 (WebSockets); the MVP polls.

## Running locally

```bash
# 1. Backend API must be running (see repo README). Then:
cp frontend/.env.example frontend/.env.local   # optional; defaults to http://localhost:3000
npm run dev --workspace frontend                # Vite dev server on http://localhost:5173
```

The API base URL is configured with `VITE_API_URL`. The backend allows the Vite origin via
`CORS_ORIGIN` (see root `.env.example`).

See [`docs/project-plan.md`](../docs/project-plan.md) for the phased plan,
[`docs/architecture.md`](../docs/architecture.md) for where the frontend fits, and
[`docs/api-spec.md`](../docs/api-spec.md) for the endpoints it calls.
