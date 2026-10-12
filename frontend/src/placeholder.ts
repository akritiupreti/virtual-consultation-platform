/**
 * Frontend scaffold placeholder.
 *
 * The React (Vite) application — triage queue, consultation room, summary and
 * admin screens — is built in Phase 2 (see docs/project-plan.md). This file
 * exists so the workspace type-checks and lints as part of CI from Phase 1.
 */
export const FRONTEND_PHASE = 'phase-2-pending' as const;

export function frontendStatus(): string {
  return `frontend scaffold ready (${FRONTEND_PHASE})`;
}
