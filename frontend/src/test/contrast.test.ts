// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Deterministic WCAG 2.1 contrast check on the design tokens (ADR-0017). jsdom
 * cannot compute rendered contrast, and Lighthouse/axe-in-a-browser is the slow
 * path; the colours are fixed tokens, so we verify the ratios of the actual
 * foreground/background pairs used on the critical screens directly from
 * styles.css. A failure here is a real AA violation to fix, not a flaky render.
 *
 * AA thresholds: 4.5:1 for normal text, 3:1 for large/bold display text.
 */
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`));
  if (!match) {
    throw new Error(`token --${name} not found in styles.css`);
  }
  return match[1];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((x) => x + x)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const surface = () => token('surface');
const bg = () => token('bg');

// Literal palette values from styles.css that are not :root tokens.
const ERROR_BG = '#fdeceb';
const BADGES = [
  { name: 'patient', fg: '#0b57d0', bg: '#e3effd' },
  { name: 'nurse/doctor', fg: '#2b7a3d', bg: '#e6f4ea' },
  { name: 'admin', fg: '#7a3db8', bg: '#f3e8fd' },
];

describe('WCAG 2.1 AA colour contrast (design tokens)', () => {
  const normal = 4.5;

  it.each([
    ['body text on page background', () => token('text'), bg, normal],
    ['body text on surface', () => token('text'), surface, normal],
    ['muted text on surface', () => token('muted'), surface, normal],
    ['muted text on page background', () => token('muted'), bg, normal],
    ['button label on primary', () => token('primary-ink'), () => token('primary'), normal],
    // Active step label in the status stepper uses --primary-700 as text.
    ['primary-700 text on surface', () => token('primary-700'), surface, normal],
    ['danger text on surface', () => token('danger'), surface, normal],
    ['danger text on error banner', () => token('danger'), () => ERROR_BG, normal],
    ['routine tier on surface', () => token('routine'), surface, normal],
    ['urgent tier on surface', () => token('urgent'), surface, normal],
    ['emergency tier on surface', () => token('emergency'), surface, normal],
  ])('%s meets AA', (_label, fg, bgc, min) => {
    expect(ratio(fg(), bgc())).toBeGreaterThanOrEqual(min);
  });

  it.each(BADGES)('role badge "$name" meets AA', ({ fg, bg: b }) => {
    expect(ratio(fg, b)).toBeGreaterThanOrEqual(4.5);
  });
});
