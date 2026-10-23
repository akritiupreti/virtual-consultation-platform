import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tier for the four critical screens (ADR-0017 / ADR-0018):
 *   - a11y.spec.ts  — @axe-core/playwright WCAG 2.1 AA scan incl. real contrast
 *   - visual.spec.ts — pixel screenshots compared to committed baselines
 *
 * The app is served as a static production build (vite preview) and the backend
 * is fully stubbed via page.route in the harness, so these are deterministic and
 * need no Postgres/Redis.
 *
 * Snapshot determinism (the known cross-platform footgun): font hinting and
 * anti-aliasing differ per OS, so baselines are PINNED to the Playwright Linux
 * container. CI runs this job inside mcr.microsoft.com/playwright and baselines
 * are generated there; regenerate locally with the documented `docker run`
 * command (docs/testing-strategy.md), never from a host OS.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  use: {
    baseURL: `http://localhost:${PORT}`,
    colorScheme: 'light',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  },
  expect: {
    toHaveScreenshot: {
      // Small tolerance absorbs sub-pixel noise without hiding real regressions.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
