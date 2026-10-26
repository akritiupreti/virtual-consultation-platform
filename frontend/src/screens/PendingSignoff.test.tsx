import { act } from '@testing-library/react';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import PendingSignoff from './PendingSignoff';

const mock = vi.hoisted(() => ({ getPendingSignoff: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});
// Capture the live signal handler (ADR-0027) so a test can play a server push.
const live = vi.hoisted(() => ({ summary: null as null | (() => void) }));
vi.mock('../lib/realtime', () => ({
  useSummaryUpdates: (cb: () => void) => {
    live.summary = cb;
  },
}));

function render() {
  return renderWithProviders(<PendingSignoff />, {
    user: fixtures.users.doctor,
    route: '/pending-signoff',
  });
}

describe('PendingSignoff (doctor)', () => {
  beforeEach(() => mock.getPendingSignoff.mockReset());

  it('lists cases awaiting sign-off, each linking to the room to review & finalize', async () => {
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    const { findAllByRole } = render();

    const links = await findAllByRole('link', { name: /review & sign off/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/consultations/c-1');
    expect(links[1]).toHaveAttribute('href', '/consultations/c-2');
  });

  it('marks a case already returned to the drafter, apart from ones ready to review', async () => {
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    const { findByText, getByText } = render();
    expect(await findByText('Returned to drafter')).toBeInTheDocument();
    expect(getByText('Ready to review')).toBeInTheDocument();
    expect(document.querySelector('.header-stat')).toHaveTextContent('1 ready to review');
  });

  it('refreshes live when a summary signal arrives (no polling wait)', async () => {
    mock.getPendingSignoff.mockResolvedValue([]);
    const { findByText, findAllByRole } = render();
    await findByText(/no consultations are awaiting sign-off/i);
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    await act(async () => live.summary?.());
    expect(await findAllByRole('link', { name: /review & sign off/i })).toHaveLength(2);
  });

  it('shows an empty state when nothing is awaiting sign-off', async () => {
    mock.getPendingSignoff.mockResolvedValue([]);
    const { findByText } = render();
    expect(await findByText(/no consultations are awaiting sign-off/i)).toBeInTheDocument();
  });

  it('surfaces an API error', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getPendingSignoff.mockRejectedValueOnce(
      new ApiError(500, 'Failed to load cases awaiting sign-off'),
    );
    const { findByText } = render();
    expect(await findByText(/failed to load cases awaiting sign-off/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    const { container, findAllByRole } = render();
    await findAllByRole('link', { name: /review & sign off/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
