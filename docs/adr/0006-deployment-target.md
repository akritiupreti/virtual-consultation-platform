# ADR-0006: Deployment target

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

The capstone is judged on engineering process, not on running a production
service. We must decide whether the system targets a hosted environment (which
needs cloud accounts, secrets management and infrastructure the owner would set
up and pay for) or a reproducible local environment. Reproducibility — "one
command brings the stack up" — is an explicit success criterion.

## Decision

Target **local Docker Compose** as the deployment environment for the project.

- Phase 1 ships Compose for the database only; Phase 5 assembles the full stack
  (backend + frontend containers) behind the same `docker compose up`.
- No hosted/cloud deployment is in scope. CI builds and tests the image but does
  not deploy it.

## Alternatives considered

- **Local Docker Compose** (chosen) — reproducible, zero external accounts,
  demonstrates containerisation and orchestration skills, and keeps scope
  disciplined. Directly satisfies the one-command-startup criterion.
- **Hosted PaaS (Render / Fly.io / Railway)** — would demonstrate real
  deployment, but adds accounts, billing, secret management and environment
  drift for little assessment benefit, and risks time better spent on the core
  workflow.
- **Kubernetes** — overkill for a solo capstone; the operational complexity would
  dwarf the application.

## Consequences

- The entire system is demonstrable on any machine with Docker installed.
- Production concerns (TLS termination, managed secrets, autoscaling) are
  discussed in `deployment.md` as future work / accepted out-of-scope, not built.
- If a hosted demo is ever wanted, it is an additive decision recorded in a new
  ADR; nothing here precludes it.
