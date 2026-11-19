import { expect, test } from '@playwright/test';
import { openScreen, SCREENS } from './harness';

/**
 * Visual-regression baselines for the four critical screens only (C25 /
 * ADR-0016). Baselines are committed under tests/e2e/__screenshots__ and MUST
 * be generated in the pinned Playwright Linux container so CI matches — see
 * docs/testing-strategy.md. A diff above the configured tolerance fails the job.
 */
for (const screen of SCREENS) {
  test(`${screen.name} matches its visual baseline`, async ({ page }) => {
    await openScreen(page, screen);
    await expect(page).toHaveScreenshot(`${screen.name}.png`, { fullPage: true });
  });
}
