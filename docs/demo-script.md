# Demo Script

A supervisor-ready walkthrough: bring the whole system up with one command, then
click through the full consultation lifecycle and the three capabilities this project
is really about — **DB-safe concurrency**, **role + state authorization / separation
of duties**, and **accessibility**. Each step says what to do and **what to look for**.

Related: [README](../README.md) (quickstart) · [architecture](architecture.md) ·
[authorization matrix](authorization-matrix.md) · [state machine](state-machine.md) ·
[testing strategy](testing-strategy.md).

---

## 0. Bring it up (one command)

```bash
# From the repo root. Requires Docker Desktop running and a root .env (copy .env.example).
docker compose up -d --build        # Postgres + Redis + backend (migrates on boot) + frontend
npm install                         # once, for the host-run seed
npm run seed --workspace backend    # demo users + sample consultations (idempotent)
```

| Surface              | URL                                   |
| -------------------- | ------------------------------------- |
| Frontend (SPA)       | http://localhost:8088                 |
| API                  | http://localhost:3100                 |
| Liveness / readiness | http://localhost:3100/health · /ready |
| Metrics (Prometheus) | http://localhost:3100/metrics         |

> Ports are the local defaults (`FRONTEND_PORT=8088`, `BACKEND_PORT=3100`,
> `POSTGRES_PORT=5433`); they are configurable in `.env`. One command brings the full
> stack up (SC-14 / NFR-8).

### Seeded users (all share one password)

| Role    | Email               | Password       |
| ------- | ------------------- | -------------- |
| Patient | `patient@vcp.local` | `Password123!` |
| Nurse   | `nurse@vcp.local`   | `Password123!` |
| Doctor  | `doctor@vcp.local`  | `Password123!` |
| Admin   | `admin@vcp.local`   | `Password123!` |

(The password is `SEED_PASSWORD` in `.env`.) The seed also adds extra dummy patients,
nurses and doctors (including a deactivated `nora.nurse@vcp.local`) and a few sample
consultations across the lifecycle, so the triage queue and the admin Users / Audit log
screens already have content on a fresh database. For the concurrency and multi-actor
steps, open **two browsers / profiles** (or one normal + one private window) so two
roles can be signed in at once.

---

## 1. The full lifecycle (the happy path)

```mermaid
sequenceDiagram
    autonumber
    participant Pt as Patient
    participant N as Nurse
    participant D as Doctor
    Pt->>Pt: /patient — submit request (intake + consent)
    Note over Pt: sees "N ahead" position, live
    N->>N: /queue — claim the case (DB-atomic)
    N->>N: start → /consultations/:id
    Pt->>N: chat (persisted + live both ways)
    N->>N: complete → draft summary
    opt Doctor disagrees with the draft
        D->>N: request changes (optional note) — stays Ended, nurse notified
        N->>N: revise the draft
    end
    D->>D: /consultations/:id/summary — finalize (doctor-only, immutable)
    Pt->>Pt: reads the finalized summary
```

1. **Patient** — sign in as `patient@vcp.local` → land on `/patient`. Submit a request
   (chief complaint, symptom category, onset, severity, **consent checkbox**). **Look
   for:** it immediately shows **Queued** with a live **"N ahead"** position.
2. **Nurse** — sign in as `nurse@vcp.local` → `/queue`. **Look for:** the queue shows
   only the **pre-claim minimum** (priority, symptom category, severity, a short
   complaint, wait time) — **no patient identity, no attachments** (data
   minimization, C7). Click **Claim**. **Look for:** the case leaves other clinicians'
   queues instantly.
3. **Nurse** — **Start** the consultation → `/consultations/:id` (state → In Session).
   Send a message. In the patient window, **look for** the message arriving **live**
   (and vice-versa); the patient's position/status updates without a refresh.
4. **Nurse** — **Complete** the consultation (→ Ended), then **draft** a summary.
   **Look for:** the nurse can draft but the **Finalize** action is not available to
   them. The case now appears on the doctor's **Pending sign-off** worklist (ADR-0020).
5. **Doctor — request changes (optional).** Sign in as `doctor@vcp.local`, open the case
   (from **Pending sign-off** or `/consultations/:id`), review the draft and click
   **Request changes** with a short note. **Look for:** the case stays **Ended** (not
   finalized); in the nurse's window a **toast** announces it live, and — even if the
   nurse missed the toast — a **"Changes requested" badge** appears on their **My
   consultations** list and a **banner with the note** shows above the draft editor in the
   room (ADR-0024/0025). The nurse edits the draft; autosaving **clears** the badge and
   banner. (The note is in-app only, never written to the audit log.)
6. **Doctor — finalize.** Once satisfied, **Finalize** (→ Summarized). **Look for:**
   finalize is **doctor-only**, and once finalized the summary is **immutable** —
   corrections would be append-only addendums. The **finalizing doctor can still read**
   the summary they signed, even on a nurse-run case they didn't run (ADR-0023).
7. **Patient** — refresh `/patient`/the summary. **Look for:** the patient can now read
   the **finalized** summary.

---

## 2. Concurrency — two clinicians, one case (the signature scenario)

The guarantee lives in the **database**, not the UI (ADR-0003, invariant 2).

- **Live demo:** seed a fresh queued request (repeat step 1 as the patient). Sign in a
  **nurse** and a **doctor** each looking at `/queue`, and click **Claim** on the same
  case at nearly the same moment. **Look for:** exactly **one** wins and opens the
  case; the other gets a clear **"already claimed"** (HTTP 409) and the case vanishes
  from their queue.
- **Proof by test (deterministic):** the same guarantee is proven by firing many
  simultaneous claims and asserting exactly one 200 and the rest 409:

  ```bash
  docker compose up -d db redis
  DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
    npx prisma migrate deploy --schema backend/src/prisma/schema.prisma
  DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
    REDIS_URL="redis://localhost:6379" CLAIM_TTL_SWEEP_INTERVAL_SECONDS=3600 LOG_PRETTY=false \
    npm run test:e2e --workspace backend
  ```

  Watch `test/e2e/claim-concurrency.e2e-spec.ts` (CS-2).

---

## 3. Authorization & separation of duties (RBAC)

- **Admin** — sign in as `admin@vcp.local`. **Look for:** the admin lands on the **Audit
  log** and the nav bar offers exactly two destinations — **Users** (`/users`) and **Audit
  log** (`/audit`). On **Users**, every account is listed with its role and status, and the
  admin can **deactivate / reactivate** others (but not themselves). There is **no way to
  open a consultation room, messages, attachments or summary** — the admin is refused
  clinical content everywhere (invariant 3, SC-6). This is enforced server-side: even
  calling the clinical API directly as an admin returns 403.
- **Audit trail** — in `/audit`, filter by consultation / event type / actor. **Look
  for:** every state change, claim, finalize and attachment access is recorded as
  **who / what / when** — and **never** a message body, attachment content or summary
  text. Each row carries a `correlationId` tying it back to the request that caused it.
- **Role/state gating** — try an action out of turn (e.g. a nurse finalizing, or acting
  on a case they don't own). **Look for:** a role violation is **403**, an action
  illegal from the current state is **409** — both from the single authorization matrix.

---

## 4. Accessibility (WCAG 2.1 AA, four critical screens)

- **Keyboard-only:** on Login, Triage Queue, Consultation Room and Summary, navigate
  with **Tab / Shift-Tab / Enter** only. **Look for:** visible focus, logical order,
  Enter submits.
- **Automated proof:**

  ```bash
  npm run test:cov --workspace frontend     # Vitest + jest-axe AA + keyboard + token-contrast
  # Browser-tier axe (real contrast) + visual regression run in the pinned Playwright container:
  docker run --rm -v "$PWD":/work -v /work/node_modules -v /work/frontend/node_modules \
    -v /work/backend/node_modules -w /work mcr.microsoft.com/playwright:v1.64.1-noble \
    bash -c "npm ci && cd frontend && npx playwright test"
  ```

  **Look for:** axe reports no AA violations on the four screens; the token-contrast
  test enforces ≥ 4.5:1 (this pass previously caught and fixed real violations).

---

## 5. Observability (optional, for the ops story)

```bash
curl -s http://localhost:3100/ready | jq      # postgres gates; redis reported, non-gating
curl -s http://localhost:3100/metrics | grep vcp_   # vcp_queue_depth, vcp_active_consultations
```

Send any request with `-H 'X-Correlation-Id: demo-trace-1'` and **look for** the same
id echoed on the response header, in the JSON logs (`docker compose logs backend`), and
on the audit rows for that action — one trace end-to-end, with no PII in any of them.

---

## One-line pitch while demoing

> "A patient's request moves through a strict state machine; a clinician claims it
> safely under a race decided by Postgres; everything is gated by one role-and-state
> authorization matrix; admins run the system but can never read clinical content; and
> it's all audited, observable, accessible and tested."
