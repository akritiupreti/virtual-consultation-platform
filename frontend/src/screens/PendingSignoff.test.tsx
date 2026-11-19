import { act } from '@testing-library/react';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import PendingSignoff from './PendingSignoff';

const mock = vi.hoisted(() => ({ getPendingSignoff: vi.fn(), getSignedOff: vi.fn() }));

const signedOff = [
  {
    id: 'c-9',
    priority: 'ROUTINE' as const,
    symptomCategory: 'Dermatology',
    complaintSummary: 'Signed complaint (synthetic)',
    endedAt: '2026-10-21T09:00:00.000Z',
    finalizedAt: '2026-10-21T09:30:00.000Z',
    draftedBy: 'u-nurse',
  },
];
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});
// Capture the live signal handler (ADR-0022) so a test can play a server push.
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
  beforeEach(() => {
    mock.getPendingSignoff.mockReset();
    mock.getSignedOff.mockReset().mockResolvedValue([]);
  });

  it("keeps the doctor's completed sign-offs under Completed, linking to the summary (ADR-0023)", async () => {
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    mock.getSignedOff.mockResolvedValue(signedOff);
    const { user, findAllByRole, getByRole, getAllByRole, getByText, queryByText } = render();

    // Active (default): only cases awaiting sign-off.
    expect(await findAllByRole('link', { name: /review & sign off/i })).toHaveLength(2);
    expect(queryByText('Signed complaint (synthetic)')).not.toBeInTheDocument();

    await user.click(getByRole('button', { name: /completed/i }));
    expect(getByText('Signed complaint (synthetic)')).toBeInTheDocument();
    expect(getByText('Signed off')).toBeInTheDocument();
    expect(getByRole('link', { name: /view summary/i })).toHaveAttribute(
      'href',
      '/consultations/c-9/summary',
    );

    await user.click(getByRole('button', { name: /^all/i }));
    expect(getAllByRole('link', { name: /review & sign off|view summary/i })).toHaveLength(3);
  });

  it('shows an empty Completed list before any sign-off', async () => {
    mock.getPendingSignoff.mockResolvedValue([]);
    const { user, findByRole, findByText } = render();
    await user.click(await findByRole('button', { name: /completed/i }));
    expect(await findByText(/not signed off any consultations yet/i)).toBeInTheDocument();
  });

  it('lists cases awaiting sign-off, each linking to the room to review & finalize', async () => {
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    const { findAllByRole } = render();

    const links = await findAllByRole('link', { name: /review & sign off/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/consultations/c-1');
    expect(links[1]).toHaveAttribute('href', '/consultations/c-2');
  });

  it('marks each waiting case ready to review and counts them in the header', async () => {
    mock.getPendingSignoff.mockResolvedValue(fixtures.pendingSignoff);
    const { findAllByText } = render();
    expect(await findAllByText('Ready to review')).toHaveLength(2);
    expect(document.querySelector('.header-stat')).toHaveTextContent('2 ready to review');
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
