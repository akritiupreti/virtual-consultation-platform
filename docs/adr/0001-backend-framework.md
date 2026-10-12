# ADR-0001: Backend framework

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

The backend must express a non-trivial domain (state machine, RBAC, real-time,
auditing) clearly and be highly testable, since the project is judged on
engineering process. TypeScript + Node is already chosen.

## Decision

Use **NestJS** for the backend.

## Alternatives considered

- **NestJS** — opinionated structure, dependency injection, first-class testing,
  guards/interceptors that map neatly to RBAC and audit cross-cutting concerns.
  Cons: more boilerplate, steeper learning curve.
- **Express / Fastify (+ chosen libraries)** — minimal, flexible, fast to start.
  Cons: architecture and testing seams must be designed by hand; easier to let
  structure drift.

## Consequences

- NestJS's guards/interceptors give clean, testable seams for the authorization
  matrix, transition checks, correlation IDs, and audit logging.
- More initial ceremony, justified by the project's emphasis on demonstrable
  architecture.
- Confirmed for Phase 1 scaffolding.
