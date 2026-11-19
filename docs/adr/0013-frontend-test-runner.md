# ADR-0013: Frontend test runner

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project owner

## Context

Through Phase 5 the React frontend (Vite) had **no tests and no test runner** — the
engineering effort was deliberately on the backend's correctness guarantees. Phase 6
introduces frontend testing from scratch: component tests for the critical screens,
plus the coverage gate (≥80%, NFR-7 / SC-11) and the component-level accessibility
checks ([ADR-0015](0015-accessibility-tooling.md)). We need a runner that fits a
Vite + React + TypeScript app without a second, divergent build pipeline.

## Decision

Use **Vitest + React Testing Library + jsdom**, with **@vitest/coverage-v8** for
coverage and **@testing-library/user-event** for interaction.

- **Vitest** reuses the project's existing Vite/`@vitejs/plugin-react` transform and
  ESM config, so tests compile exactly like the app — no separate Babel/Jest setup.
  Its API mirrors Jest (the backend's runner), so the two workspaces feel the same.
- **React Testing Library** drives components the way a user does (roles, labels,
  text) rather than asserting on implementation details.
- **jsdom** provides a DOM without a browser — fast and CI-friendly. Its limits
  (no layout, no computed contrast) are covered by the browser tier
  ([ADR-0016](0016-visual-regression.md) / [ADR-0015](0015-accessibility-tooling.md)).
- Tests are co-located under `src/**` as `*.test.tsx`, typechecked with the app, and
  wired into the root `npm test` / CI. The API and realtime modules are mocked so
  component tests are deterministic and need no backend.

## Alternatives considered

- **Vitest** (chosen) — Vite-native, fast, one build pipeline, Jest-compatible API.
- **Jest + ts-jest + jsdom** — works, and matches the backend runner, but needs its
  own transform config for Vite/ESM and `import.meta.env`, duplicating build setup
  the app already expresses in Vite. More moving parts for no gain here.
- **Playwright component testing** — real browser rendering, but heavier per test and
  still experimental; we already use Playwright for the browser tier (a11y contrast +
  visual), so keeping the fast unit/component tier in jsdom is the right split.
- **Cypress component testing** — capable but a large dependency oriented around its
  own runner/UI; overkill for a solo capstone's component tests.

## Consequences

- Adds dev dependencies: `vitest`, `@vitest/coverage-v8`, `@testing-library/react`,
  `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`.
- Frontend gains `test` / `test:cov` scripts; CI runs `test:cov` with the ≥80% gate.
- The jsdom contrast blind spot is handled deliberately: a token-contrast unit test
  and a real-browser axe pass ([ADR-0015](0015-accessibility-tooling.md)).
- Test strategy and the updated pyramid live in
  [testing-strategy.md](../testing-strategy.md).
