# ADR-0005: Authentication & authorization approach

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

Every action must be authenticated and authorized by **role and consultation
state**, with a hard separation-of-duties boundary (admins cannot read clinical
content). Authorization must be centralized and testable.

## Decision

- **Authentication:** **short-lived JWT access tokens** (15 minutes); passwords
  stored as **bcrypt** hashes. Every request re-checks that the account is still
  active, so a deactivated user's token stops working at once.
- **Authorization:** a single **authorization matrix** keyed by
  _action × role × state × ownership_ ([authorization-matrix.md](../authorization-matrix.md)),
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
- WebSocket connections are authenticated with the same token
  ([ADR-0004](0004-realtime-websockets.md)).
- When the token expires the user signs in again. Refresh-token rotation is the
  production follow-up, noted in [security-privacy.md](../security-privacy.md).
- The separation-of-duties rule is an explicit, tested invariant.
