# Success Criteria

Measurable outcomes the system is evaluated against. Each criterion is objective
and testable, and maps back to a requirement in [requirements.md](requirements.md).

## Functional correctness

| # | Criterion | How it's measured | Ref |
|---|-----------|-------------------|-----|
| SC-1 | Full lifecycle works end-to-end | E2E test drives Requested → Summarized and passes | FR-17 |
| SC-2 | Exactly one clinician wins a contested claim | Concurrency test fires simultaneous claims; exactly one 200, others 409 | FR-9 |
| SC-3 | Claiming does not auto-start a session | Test asserts `CLAIMED` state until explicit start | FR-8 |
| SC-4 | Unstarted claims auto-requeue | Test advances past start TTL; case returns to `QUEUED`, audited | FR-12 |
| SC-5 | Invalid transitions are rejected | Each invalid transition returns the expected 4xx | FR-17 |

## Security & privacy

| # | Criterion | How it's measured | Ref |
|---|-----------|-------------------|-----|
| SC-6 | Admins cannot read clinical content | Test: admin requests messages/attachments/summary → denied | FR-16 |
| SC-7 | No privilege escalation across roles | Negative authz tests for each matrix cell marked ❌ | NFR-1 |
| SC-8 | Attachments only via scoped signed URLs | Test: unauthenticated/cross-consultation access fails | NFR-2 |
| SC-9 | No PII/clinical data in logs or URLs | Log/URL inspection test + review | NFR-2 |

## Quality & delivery

| # | Criterion | Target | Ref |
|---|-----------|--------|-----|
| SC-10 | Backend test coverage | ≥ 90% (CI-gated) | NFR-7 |
| SC-11 | Frontend test coverage | ≥ 80% (CI-gated) | NFR-7 |
| SC-12 | Critical scenarios covered | 100% of the list in testing-strategy.md | NFR-7 |
| SC-13 | Accessibility on critical screens | WCAG 2.1 AA (axe/Lighthouse pass) | NFR-6 |
| SC-14 | One-command local startup | `docker compose up` brings up the full stack | NFR-8 |
| SC-15 | Traceability | A request is traceable end-to-end by correlation ID | NFR-5 |
| SC-16 | Green pipeline | CI/CD passes on every merge to `main` | — |

## Process & communication

| # | Criterion | How it's measured |
|---|-----------|-------------------|
| SC-17 | Design is diagram-driven | Architecture, state machine, ER, sequence, authz boundary diagrams exist |
| SC-18 | Decisions are recorded | Each significant decision has an ADR in `docs/adr/` |
| SC-19 | Reflection is captured | `retrospective.md` completed at the end |
