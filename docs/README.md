# Documentation Index

All design documentation for the Virtual Consultation Platform. Status legend:
✅ written · 🟡 in progress · ⬜ planned (authored in the phase noted).

## Planning (Phase 0)

| Doc                                | Purpose                                                                                            | Status |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| [project-plan.md](project-plan.md) | Phases, MVP definition, milestones, Gantt, documentation & scaffolding plan, risks, capability map | ✅     |

## Requirements & design (Phase 0 → 1)

| Doc                                                | Purpose                                                                               | Status       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------ |
| [requirements.md](requirements.md)                 | Functional + non-functional requirements; required vs optional fields                 | ✅           |
| [state-machine.md](state-machine.md)               | Consultation state machine: valid/invalid transitions, guards, exceptions (+ Mermaid) | ✅           |
| [authorization-matrix.md](authorization-matrix.md) | Resource × action × role × state permission matrix                                    | ✅           |
| [data-model.md](data-model.md)                     | Entities & relationships, ER diagram (+ Mermaid)                                      | ✅           |
| [architecture.md](architecture.md)                 | System architecture, component responsibilities, trade-offs (+ diagrams)              | ✅           |
| [api-spec.md](api-spec.md)                         | REST endpoints + WebSocket event contracts + attachments/users/audit (Phase 4)        | ✅ Phase 2–4 |

## Cross-cutting concerns

| Doc                                        | Purpose                                                                                                | Status       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------ |
| [security-privacy.md](security-privacy.md) | Threat model: unauthorized access, privilege escalation, attachment access, data exposure, mitigations | ✅ Phase 4   |
| [audit-logging.md](audit-logging.md)       | Catalogue of auditable events ("important" defined) + log schema + admin query boundary                | ✅ Phase 4   |
| observability.md                           | Structured logging, correlation IDs, health checks, metrics                                            | ⬜ Phase 5   |
| [testing-strategy.md](testing-strategy.md) | Critical scenarios, test pyramid, coverage gates, accessibility, visual regression                     | 🟡 Phase 2–4 |
| deployment.md                              | Docker Compose topology, environments, CI/CD pipeline stages                                           | ⬜ Phase 5   |
| [success-criteria.md](success-criteria.md) | Measurable outcomes the system is evaluated against                                                    | ✅           |

## Decisions & reflection

| Doc              | Purpose                                                                                | Status     |
| ---------------- | -------------------------------------------------------------------------------------- | ---------- |
| [adr/](adr/)     | Architecture Decision Records (template + 0001–0012; more added as decisions are made) | 🟡 ongoing |
| retrospective.md | End-of-project reflection: wrong assumptions, risks, lessons, redesigns                | ⬜ Phase 7 |
