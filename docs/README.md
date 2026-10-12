# Documentation Index

All design documentation for the Virtual Consultation Platform. Status legend:
✅ written · 🟡 in progress · ⬜ planned (authored in the phase noted).

## Planning (Phase 0)

| Doc | Purpose | Status |
|-----|---------|--------|
| [project-plan.md](project-plan.md) | Phases, MVP definition, milestones, Gantt, documentation & scaffolding plan, risks, capability map | ✅ |

## Requirements & design (Phase 0 → 1)

| Doc | Purpose | Status |
|-----|---------|--------|
| requirements.md | Functional + non-functional requirements; required vs optional fields | ⬜ Phase 0/1 |
| state-machine.md | Consultation state machine: valid/invalid transitions, guards, exceptions (+ Mermaid) | ⬜ Phase 0/1 |
| authorization-matrix.md | Resource × action × role × state permission matrix | ⬜ Phase 0/1 |
| data-model.md | Entities & relationships, ER diagram (+ Mermaid) | ⬜ Phase 0/1 |
| architecture.md | System architecture, component responsibilities, trade-offs (+ diagrams) | ⬜ Phase 1 |
| api-spec.md | REST endpoints + WebSocket event contracts (OpenAPI where possible) | ⬜ Phase 1/2 |

## Cross-cutting concerns

| Doc | Purpose | Status |
|-----|---------|--------|
| security-privacy.md | Threat model: unauthorized access, privilege escalation, attachment access, data exposure, mitigations | ⬜ Phase 1/4 |
| audit-logging.md | Catalogue of auditable events ("important" defined) + log schema | ⬜ Phase 4 |
| observability.md | Structured logging, correlation IDs, health checks, metrics | ⬜ Phase 5 |
| testing-strategy.md | Critical scenarios, test pyramid, coverage gates, accessibility, visual regression | ⬜ Phase 2/6 |
| deployment.md | Docker Compose topology, environments, CI/CD pipeline stages | ⬜ Phase 5 |
| success-criteria.md | Measurable outcomes the system is evaluated against | ⬜ Phase 0/1 |

## Decisions & reflection

| Doc | Purpose | Status |
|-----|---------|--------|
| adr/ | Architecture Decision Records (one file per decision; see template) | ⬜ ongoing |
| retrospective.md | End-of-project reflection: wrong assumptions, risks, lessons, redesigns | ⬜ Phase 7 |
