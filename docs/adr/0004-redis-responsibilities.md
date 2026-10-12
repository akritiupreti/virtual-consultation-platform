# ADR-0004: Redis responsibilities (and non-responsibilities)

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

The platform needs real-time behaviour (live queue, presence) that scales beyond
a single API instance. The reviewer asked explicitly *why* Redis is needed.

## Decision

Use **Redis** for ephemeral, real-time concerns only:
- **Presence** — who is currently online/connected.
- **Pub/sub fan-out** — broadcasting queue/room events across API instances.
- **Cached queue positions** — fast "N ahead of you" reads.
- **Rate limiting** and short-lived **ephemeral state** (e.g. claim-start timers).

Redis is **not** a system of record. All durable data lives in PostgreSQL
([ADR-0002](0002-postgresql-system-of-record.md)).

## Alternatives considered

- **In-memory (single process)** — simplest, but breaks with more than one API
  instance (presence and pub/sub would not be shared).
- **Postgres LISTEN/NOTIFY** — avoids a dependency, but is weaker for presence and
  high-fan-out broadcast and couples real-time load to the primary DB.

## Consequences

- Clear separation: Postgres = truth, Redis = speed/ephemerality.
- Adds an operational dependency (included in Docker Compose).
- Must handle Redis unavailability gracefully (degrade real-time, keep core flows).
