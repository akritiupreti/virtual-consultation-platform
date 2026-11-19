# ADR-0004: Real-time transport (WebSockets)

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

Clinicians need a live triage queue and patients/clinicians need live messaging.
Updates must be pushed from server to client promptly.

## Decision

Use **WebSockets** for bidirectional real-time communication (queue updates,
room messaging, consultation state changes).

For the **MVP**, messaging is persisted via REST and the room can poll; the
WebSocket layer is introduced in Phase 3 so the core workflow lands first.

## Alternatives considered

- **WebSockets** (chosen) — true push, low latency, natural fit for chat + queue.
- **Server-Sent Events** — simpler, but one-directional (no client→server stream).
- **Polling only** — fine for the MVP, too chatty/laggy as the steady state.

## Consequences

- Requires connection lifecycle handling (auth on connect, reconnect, cleanup).
- Clients reconcile from the server's authoritative state on reconnect.
- Phased rollout keeps the MVP simple and de-risks the real-time work.
