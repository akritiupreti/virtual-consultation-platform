# ADR-0004: Real-time over WebSockets (socket.io)

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

Clinicians need a live triage queue, patients and clinicians need live messaging,
and doctors need to see a case the moment it is ready for sign-off. Updates must be
pushed from server to client promptly, and the same authorization rules must hold
over a socket as over REST.

## Decision

Use **WebSockets**, implemented with **`socket.io`** via **`@nestjs/platform-socket.io`**.

- **Rooms are the authorization unit.** Membership is granted only after the **same
  authorization matrix** check the REST path uses (role → state → ownership):
  - `queue` — triage-queue signals, clinicians only;
  - `consultation:<id>` — room events, the two participants only;
  - `user:<id>` — a user's own updates (a patient's queue position and state
    changes; a clinician's "My consultations" list);
  - `signoff` — every socket whose verified JWT role is `DOCTOR`, so the sign-off
    worklist updates live for all doctors ([ADR-0009](0009-doctor-signoff-of-nurse-run-cases.md)).

  So an admin can never join a clinical room and a patient can never join the
  `queue` room (invariants 3 & 4 hold over WebSockets too).

- **JWT on the handshake.** The client sends its access token in the socket
  handshake `auth`; the gateway verifies it with the same `JWT_SECRET` as the REST
  guards and re-checks that the account is still active. An unauthenticated,
  expired or deactivated token is rejected at connect.
- **Events are signals, not data.** Queue, position and summary events carry only
  ids, states, counts or a reason. Message bodies are emitted **only** into the
  private `consultation:<id>` room. Clients re-read the real data over REST, where
  the matrix applies; PostgreSQL stays authoritative.

### Why socket.io over native `ws`

- First-class Nest support (`@WebSocketGateway`, lifecycle hooks, DI).
- **Rooms** map directly onto the authorization boundaries we already have, so the
  story is "join = matrix check" rather than hand-rolled subscription bookkeeping.
- Built-in heartbeats and automatic client reconnection, without bespoke code.

## Alternatives considered

- **WebSockets via socket.io** (chosen) — true push, low latency, rooms as the
  permission boundary, reconnection built in.
- **Native `ws` gateway** — lighter, but no rooms; we would re-implement
  reconnection, heartbeats and room bookkeeping by hand. Rejected.
- **Server-Sent Events** — simpler, but one-directional; the client still needs a
  way to join rooms. Rejected.
- **Polling only** — too chatty and laggy as the steady state. Kept only as a slow
  fallback in the UI in case a socket drops.

## Consequences

- Requires connection lifecycle handling (auth on connect, reconnect, cleanup);
  clients reconcile from the server's authoritative state on reconnect.
- The app runs as a **single API instance** (ADR-0006, local Docker Compose), so
  socket.io's built-in in-memory adapter delivers every event; no extra
  infrastructure is needed.
- Live behaviour is proven by an e2e suite that connects real socket.io clients to a
  listening app; see [testing-strategy.md](../testing-strategy.md).
