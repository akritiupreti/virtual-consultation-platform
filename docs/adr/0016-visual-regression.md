# ADR-0016: Visual-regression tooling & baseline strategy

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project owner

## Context

Visual regression is scoped to a **small, fixed set** of critical screens — login,
triage queue, consultation room, summary — not the whole app (C25). The goal is to
catch unintended visual changes (a broken layout, a colour/contrast regression) on the
screens that matter, repeatably and in CI. Two things make this non-trivial: the
screens need the backend to render, and pixel baselines are notoriously
**non-deterministic across operating systems** (font hinting and anti-aliasing
differ), which is the classic source of flaky snapshot suites.

## Decision

Use **Playwright `toHaveScreenshot`** on the four screens, rendered through a
**mock-API harness**, with baselines **pinned to the Playwright Linux container**.

- **Rendering without a backend:** the app is served as a static production build
  (`vite preview`); Playwright `page.route` stubs the REST endpoints with synthetic
  fixtures and seeds the auth token in `localStorage`, and the socket.io transport is
  blocked. So the screens render deterministically with **no Postgres** and no
  real data (invariant 6). The same harness drives the `@axe-core/playwright` a11y
  pass ([ADR-0015](0015-accessibility-tooling.md)) — one harness, two jobs.
- **Baseline determinism (the footgun):** snapshots are generated and compared **only**
  inside the pinned `mcr.microsoft.com/playwright:v<version>-noble` container, so the
  browser build, fonts and anti-aliasing are identical between a developer's machine
  and CI. Baselines are committed under `frontend/tests/e2e/__screenshots__/`. The
  `snapshotPathTemplate` drops the per-OS suffix because the container is the single
  supported platform. A developer regenerates them with the documented one-line
  `docker run … --update-snapshots` command — **never** from a host OS (a Windows/macOS
  run would produce baselines that fail in CI).
- **Tolerance:** a small `maxDiffPixelRatio` absorbs sub-pixel noise without hiding a
  real regression; animations are disabled.

## Alternatives considered

- **Playwright screenshots, container-pinned** (chosen) — one tool for a11y + visual,
  deterministic baselines, runs in CI with no app-server infra.
- **Host-generated baselines** — simplest to produce, but guarantees cross-OS snapshot
  flakiness between a contributor's machine and the CI runner. Rejected — this is the
  specific failure mode we were asked to avoid.
- **A hosted service (Percy, Chromatic, Applitools)** — robust diffing and review UIs,
  but require an account/token and recurring cost, conflicting with the local-only
  deployment target (ADR-0006). Overkill for four screens.
- **jsdom/Vitest DOM snapshots** — serialise the DOM, not pixels; they would miss the
  very regressions (layout, contrast) visual testing exists to catch.
- **Storybook + a visual addon** — a good option at larger scale, but adds a whole
  component-explorer toolchain for four screens; the route-mock harness is lighter.

## Consequences

- Adds the `@playwright/test` dev dependency; the browser download and baseline
  generation are **manual/Docker steps**, flagged in
  [testing-strategy.md](../testing-strategy.md).
- CI runs the visual job inside the pinned container, comparing against committed
  baselines; a diff above tolerance fails the build.
- Baselines are an artifact in the repo: an intended visual change is reviewed as a
  baseline update (regenerated in-container) in the same PR, keeping visual changes
  explicit and reviewable.
