import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Frontend unit/component test runner (ADR-0013): Vitest + React Testing Library
// + jsdom. Shares the Vite/React transform so there is one build pipeline. The
// Playwright a11y/visual suites live under tests/e2e and are NOT run here.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      // Coverage gate (ADR-0014 / NFR-7 / SC-11): frontend >= 80%. Exclude the
      // app entrypoint, type-only modules, the test harness, and the Playwright
      // suites (browser-driven, not counted here).
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/test/**', 'src/**/*.test.{ts,tsx}', 'src/vite-env.d.ts'],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
