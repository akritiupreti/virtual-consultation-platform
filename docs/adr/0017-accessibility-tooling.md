# ADR-0017: Accessibility tooling

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project owner

## Context

The critical screens — login, triage queue, consultation room, summary — must meet
**WCAG 2.1 AA**, verified with automated tooling (axe and/or Lighthouse) plus
keyboard-navigation and contrast checks (NFR-6 / SC-13 / C24). We want checks that
run in CI, are deterministic, and genuinely catch the common failures (missing
labels/roles, heading order, focus order, and colour contrast) rather than a single
score that hides them.

No single layer does all of this well: jsdom is fast and CI-friendly but has **no
layout and no computed colour**, so it cannot judge contrast; a real browser can, but
is slower. We split the checks to match each tool's strength.

## Decision

Use **axe-core** as the engine, in **two tiers**, plus an explicit contrast check and
keyboard assertions:

1. **Component tier (fast, jsdom, every PR):** `jest-axe` runs the axe AA ruleset on
   each of the four screens rendered in Vitest, catching roles, names, labels, ARIA
   and heading structure. Keyboard navigation (tab order, focus, Enter-to-submit) is
   asserted with `@testing-library/user-event` in the same component tests.
2. **Browser tier (real contrast, Playwright):** `@axe-core/playwright` runs the full
   WCAG 2.1 A/AA tag set against each screen rendered in Chromium, where axe can
   compute **colour contrast** against the real layout — the thing jsdom cannot see.
   A keyboard-reachability smoke check runs here too. This tier shares its harness
   with visual regression ([ADR-0018](0018-visual-regression.md)).
3. **Token-contrast unit test:** a deterministic test computes the WCAG contrast ratio
   of every foreground/background token pair in `styles.css` and asserts ≥4.5:1. It
   runs in the fast tier (no browser), so a contrast regression fails a normal PR, and
   it documents the exact pairs that must hold.

This Phase 6 pass found and fixed real AA violations: `--muted`, the `--urgent` tier
colour, and the patient role badge were below 4.5:1 and were darkened.

## Alternatives considered

- **axe (two-tier) + token test** (chosen) — fast structural checks on every PR, real
  contrast in a browser, and a deterministic contrast gate that needs no browser.
- **Lighthouse CI only** — gives an a11y score and runs audits, but is heavier, its
  score aggregates/obscures individual failures, and it is awkward to assert
  per-screen in unit CI. axe gives rule-level, assertable results. (Lighthouse remains
  a reasonable manual spot-check.)
- **jsdom axe only** — fast but cannot judge contrast, the most common real AA
  failure; it would have missed the violations we fixed.
- **Manual auditing only** — not repeatable, not CI-enforceable; fails SC-13's "verified
  with automated tooling".

## Consequences

- Adds dev dependencies: `jest-axe` (fast tier) and `@axe-core/playwright` (browser
  tier); the browser tier needs the Playwright Chromium download (see
  [testing-strategy.md](../testing-strategy.md)).
- a11y is enforced at two levels; the fast tier gates every PR, the browser tier runs
  in the dedicated Playwright CI job.
- Contrast is pinned by a unit test, so palette changes are checked automatically —
  the token values in `styles.css` cannot silently regress below AA.
