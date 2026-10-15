# ADR-0009: Real-time implementation (socket.io + Redis adapter)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

[ADR-0005](0005-realtime-websockets.md) chose **WebSockets** as the transport and
[ADR-0004](0004-redis-responsibilities.md) made **Redis** responsible for
pub/sub fan-out and presence. Phase 3 executes those decisions, which leaves two
_implementation_ choices still open:

1. **Which WebSocket library** on the NestJS side — the first-class
   `socket.io` integration, or the lower-level native `ws` gateway.
2. **How cross-instance fan-out is wired** — so an event produced on API instance
   A reaches a subscriber connected to API instance B (ADR-0004's pub/sub).

These are genuinely new decisions, not a re-ratification of ADR-0004/0005, so they
get their own record.

## Decision

Use **`socket.io`** via **`@nestjs/platform-socket.io`**, with
**`@socket.io/redis-adapter`** (backed by `ioredis`) fanning events out across API
instances.

- **Rooms are the authorization unit.** A single `queue` room carries triage-queue
  signals to clinicians; one room per consultation (`consultation:<id>`) carries
  room events to its two participants; one personal room per user (`user:<id>`)
  carries a patient's live queue position. Membership is granted only after the
  **same authorization matrix** check the REST path uses (role → state →
  ownership), so an admin can never join a clinical room and a patient can never
  join the `queue` room (invariants 3 & 4 hold over WebSockets too).
- **JWT on the handshake.** The client sends its access token in the socket
  handshake `auth`; the gateway verifies it with the same `JWT_SECRET`/`JwtModule`
  as the REST guards. An unauthenticated or expired token is rejected at connect.
- **Payloads carry no clinical data beyond what the matrix already allows.** Queue
  and position events carry only opaque ids, states and counts. Message bodies are
  emitted **only** into the private `consultation:<id>` room, whose membership is
  exactly the participants the matrix permits to read messages — never broadcast.
- **The server never trusts the client for state.** Events are signals/minimal
  payloads; clients reconcile authoritative state from REST (and from the DB behind
  it). Redis is not a source of truth (ADR-0004); PostgreSQL stays authoritative.

### Why socket.io over native `ws`

- First-class Nest support (`@WebSocketGateway`, lifecycle hooks, DI) — clean,
  testable seams, consistent with the module structure.
- **Rooms** map directly onto the authorization boundaries we already have, so the
  AuthZ story is "join = matrix check" rather than hand-rolled subscription
  bookkeeping.
- `@socket.io/redis-adapter` delivers ADR-0004's cross-instance pub/sub fan-out
  essentially for free, and degrades cleanly to a single-instance in-memory adapter
  when Redis is absent.
- Built-in heartbeats and automatic client reconnection give us the reconnection
  behaviour ADR-0005 requires without bespoke code.

## Alternatives considered

- **Native `ws` gateway (`@nestjs/platform-ws`)** — smaller dependency and lighter
  payloads, but no rooms, no adapter ecosystem, and we would re-implement
  reconnection, heartbeats and cross-instance fan-out by hand. Rejected: more code
  to get the same guarantees, with weaker testability.
- **Raw Redis pub/sub wired into a `ws` gateway ourselves** — maximum control, but
  we would own the fan-out, room bookkeeping and reconnection logic. Rejected as
  reinventing `@socket.io/redis-adapter` for no assessment benefit.
- **socket.io without the Redis adapter** — fine for a single instance (and it is
  our graceful-degradation fallback), but it cannot fan out across instances, which
  is the whole point of ADR-0004. Kept only as the degraded mode.

## Consequences

- Adds dependencies: `@nestjs/websockets`, `@nestjs/platform-socket.io`,
  `socket.io`, `@socket.io/redis-adapter`, `ioredis` (backend) and
  `socket.io-client` (frontend).
- Redis becomes a runtime dependency **for multi-instance fan-out and presence
  only**. If `REDIS_URL` is unset or Redis is unreachable, the gateway falls back
  to the in-memory adapter and in-memory presence, logs a warning, and all core
  flows (including single-instance live updates) keep working (ADR-0004
  consequence: "degrade real-time, keep core flows").
- Cross-instance fan-out is the one behaviour that _requires_ Redis, so it is
  verified with a running Redis rather than in the Postgres-only unit path; see
  [testing-strategy.md](../testing-strategy.md).
- Claim-start TTL (the auto-requeue) is intentionally **not** built on socket.io or
  Redis timers; its mechanism is a separate decision — see
  [ADR-0010](0010-claim-start-ttl.md).
