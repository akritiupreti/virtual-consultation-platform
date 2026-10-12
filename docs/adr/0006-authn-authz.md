# ADR-0006: Authentication & authorization approach

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

Every action must be authenticated and authorized by **role and consultation
state**, with a hard separation-of-duties boundary (admins cannot read clinical
content). Authorization must be centralized and testable.

## Decision

- **Authentication:** token-based sessions using **JWT access tokens** (short
  lived) plus refresh tokens; passwords stored with a strong hash (e.g. argon2/bcrypt).
- **Authorization:** a single **authorization matrix** keyed by
  *action × role × state × ownership* ([authorization-matrix.md](../authorization-matrix.md)),
  enforced server-side via guards that share the transition registry
  ([state-machine.md](../state-machine.md)). **Deny by default.**

## Alternatives considered

- **JWT + central matrix** (chosen) — stateless verification, clean mapping to
  roles/states, easy to unit-test each cell.
- **Server-side sessions only** — simple, but less convenient for WebSocket auth
  and horizontal scaling.
- **Scattered per-endpoint checks** — rejected: duplicative, error-prone, hard to
  audit for gaps.

## Consequences

- One place defines who-can-do-what; negative tests can assert every denied cell.
- Must handle token expiry/refresh and authenticate WebSocket connections.
- The separation-of-duties rule is an explicit, tested invariant.
