# ADR-0002: PostgreSQL as the system of record

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

The domain is relational (users, consultations, messages, summaries, audit) with
strong integrity needs and a concurrency-critical claim operation. We need
transactional guarantees and expressive constraints.

## Decision

Use **PostgreSQL** as the durable system of record, accessed via **Prisma**.

## Alternatives considered

- **PostgreSQL** — ACID transactions, rich constraints, row locking and atomic
  conditional updates (needed for safe claims), mature tooling.
- **A document store (e.g. MongoDB)** — flexible schema, but weaker multi-row
  transactional guarantees and a poorer fit for relational integrity + the claim
  concurrency model.

## Consequences

- Claim correctness can be guaranteed in the database (see [ADR-0003](0003-claim-concurrency.md)).
- Prisma gives typed access and migration history (a reviewable artifact).
- Schema changes require migrations — acceptable and desirable for traceability.
