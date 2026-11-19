import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterEach, expect } from 'vitest';

// Wire the axe matcher (ADR-0015) into Vitest's expect. jest-axe is framework-
// agnostic — it only needs expect.extend — so it works unchanged under Vitest.
expect.extend(toHaveNoViolations);

// React Testing Library does not auto-clean under Vitest unless globals are on
// AND the adapter hooks in; do it explicitly so tests are isolated.
afterEach(() => {
  cleanup();
  // Guarded: node-environment test files (e.g. the token-contrast check) run
  // this setup too but have no localStorage.
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
});
