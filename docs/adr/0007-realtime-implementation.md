# ADR-0007: Real-time implementation (socket.io)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

[ADR-0004](0004-realtime-websockets.md) chose **WebSockets** as the transport.
Phase 3 executes that decision, which leaves an _implementation_ choice open:
**which WebSocket library** to use on the NestJS side — the first-class
`socket.io` integration, or the lower-level native `ws` gateway — and how to make
sure the same authorization rules hold over a socket as over REST.

## Decision

Use **`socket.io`** via **`@nestjs/platform-socket.io`**.

- **Rooms are the authorization unit.** A single `queue` room carries triage-queue
  signals to clinicians; one room per consultation (`consultation:<id>`) carries
  room events to its two participants; one personal room per user (`user:<id>`)
  carries a patient's live queue position and state changes. Membership is granted
  only after the **same authorization matrix** check the REST path uses (role →
  state → ownership), so an admin can never join a clinical room and a patient can
  never join the `queue` room (invariants 3 & 4 hold over WebSockets too).
- **JWT on the handshake.** The client sends its access token in the socket
  handshake `auth`; the gateway verifies it with the same `JWT_SECRET`/`JwtModule`
  as the REST guards and re-checks that the account is still active. An
  unauthenticated, expired or deactivated token is rejected at connect.
- **Payloads carry no clinical data beyond what the matrix already allows.** Queue
  and position events carry only opaque ids, states and counts. Message bodies are
  emitted **only** into the private `consultation:<id>` room, whose membership is
  exactly the participants the matrix permits to read messages — never broadcast.
- **The server never trusts the client for state.** Events are signals/minimal
  payloads; clients reconcile authoritative state from REST (and from the DB behind
  it). PostgreSQL stays authoritative.

### Why socket.io over native `ws`

- First-class Nest support (`@WebSocketGateway`, lifecycle hooks, DI) — clean,
  testable seams, consistent with the module structure.
- **Rooms** map directly onto the authorization boundaries we already have, so the
  AuthZ story is "join = matrix check" rather than hand-rolled subscription
  bookkeeping.
- Built-in heartbeats and automatic client reconnection give us the reconnection
  behaviour ADR-0004 requires without bespoke code.

## Alternatives considered

- **Native `ws` gateway (`@nestjs/platform-ws`)** — smaller dependency and lighter
  payloads, but no rooms, and we would re-implement reconnection, heartbeats and
  room bookkeeping by hand. Rejected: more code to get the same guarantees, with
  weaker testability.
- **Server-Sent Events** — simpler, but one-directional; the client still needs a
  way to join rooms. Rejected in ADR-0004.

## Consequences

- Adds dependencies: `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`
  (backend) and `socket.io-client` (frontend).
- The app runs as a **single API instance** (ADR-0006, local Docker Compose), so
  socket.io's built-in in-memory adapter delivers every event; no extra
  infrastructure is needed.
- Live behaviour is proven by an e2e suite that connects real socket.io clients to a
  listening app; see [testing-strategy.md](../testing-strategy.md).
