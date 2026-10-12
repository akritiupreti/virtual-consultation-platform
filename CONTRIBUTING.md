# Contributing & Engineering Conventions

This file turns vague goals like "clean git history and good documentation" into
**measurable, checkable rules** (addressing reviewer feedback that such terms
must be defined).

## Git history — what "clean" means here

- **Conventional Commits** for every commit message:
  `type(scope): subject` where `type ∈ {feat, fix, docs, test, refactor, chore,
  ci, perf, build, style}`. Example: `feat(queue): add priority-aware ordering`.
- **No WIP / "fix typo" / "asdf" commits on `main`.** Squash-merge feature
  branches so each commit on `main` is a self-contained, reviewed change.
- **Linear history on `main`** (squash or rebase merges; no merge commits).
- Every commit on `main` **builds and passes CI** (green pipeline required to merge).
- Subject line ≤ 72 chars, imperative mood ("add", not "added").
- Reference the related doc/ADR or issue in the body when relevant.

## Branching

- `main` is always releasable.
- Work on short-lived branches: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Open a Pull Request; merge only after review + green CI.

## Definition of Done (per change)

A change is "done" when:
1. Code + tests are written and passing locally.
2. It respects the [design invariants](README.md#design-invariants).
3. New capability ships with its **demonstrating artifact** (diagram/doc/test).
4. Docs touched by the change are updated (including `docs/README.md` index).
5. CI is green.

## Documentation

- Design docs live in `docs/`. Keep the index (`docs/README.md`) current.
- Prefer **Mermaid diagrams** (render natively on GitHub) over screenshots.
- Record meaningful decisions as **ADRs** in `docs/adr/` using the template.

## Testing expectations

- Critical scenarios are defined in `docs/testing-strategy.md` and are
  **mandatory**, independent of raw coverage numbers.
- Coverage targets: backend ≥ 90%, frontend ≥ 80% (gated in CI), but coverage is
  a floor, not the goal — the critical scenarios are.

## Secrets & data

- Never commit `.env`, secrets, the `.docx` spec, or any real clinical data.
- Use `.env.example` to document required environment variables.
