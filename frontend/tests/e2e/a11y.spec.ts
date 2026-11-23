import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openScreen, SCREENS } from './harness';

/**
 * WCAG 2.1 AA scan of the four critical screens in a real browser (docs/testing-strategy.md).
 * This complements the fast jsdom `vitest-axe` checks by catching what jsdom
 * cannot: computed colour contrast against the rendered layout. Keyboard focus
 * order is smoke-checked here too; the detailed keyboard assertions live in the
 * component tests.
 */
for (const screen of SCREENS) {
  test(`${screen.name} has no WCAG 2.1 AA violations`, async ({ page }) => {
    await openScreen(page, screen);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test(`${screen.name} is keyboard reachable`, async ({ page }) => {
    await openScreen(page, screen);
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
    expect(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']).toContain(active);
  });
}
