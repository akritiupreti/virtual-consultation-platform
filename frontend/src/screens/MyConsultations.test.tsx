import { act } from '@testing-library/react';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import MyConsultations from './MyConsultations';

const mock = vi.hoisted(() => ({ getAssigned: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});
const live = vi.hoisted(() => ({ assigned: null as null | (() => void) }));
vi.mock('../lib/realtime', () => ({
  useAssignedUpdates: (cb: () => void) => {
    live.assigned = cb;
  },
}));

function render() {
  return renderWithProviders(<MyConsultations />, {
    user: fixtures.users.doctor,
    route: '/assigned',
  });
}

describe('MyConsultations (clinician)', () => {
  beforeEach(() => mock.getAssigned.mockReset());

  it('lists active cases by default, and finished ones under Completed', async () => {
    mock.getAssigned.mockResolvedValue(fixtures.assignedConsultations);
    const { user, findAllByRole, getAllByRole, getByRole, queryAllByRole } = render();

    // Active: only the CLAIMED case (c-2); the finalized one is not cluttering the list.
    const roomLinks = await findAllByRole('link', { name: /open room/i });
    expect(roomLinks).toHaveLength(1);
    expect(roomLinks[0]).toHaveAttribute('href', '/consultations/c-2');
    expect(queryAllByRole('link', { name: /view summary/i })).toHaveLength(0);

    await user.click(getByRole('button', { name: /completed/i }));
    const summaryLinks = getAllByRole('link', { name: /view summary/i });
    expect(summaryLinks).toHaveLength(1);
    expect(summaryLinks[0]).toHaveAttribute('href', '/consultations/c-1/summary');

    await user.click(getByRole('button', { name: /^all/i }));
    expect(getAllByRole('link', { name: /open room/i })).toHaveLength(2);
  });

  it('tells the clinician the next step for each case', async () => {
    mock.getAssigned.mockResolvedValue([
      { ...fixtures.assignedConsultations[1], id: 'c-a' },
      {
        ...fixtures.assignedConsultations[1],
        id: 'c-b',
        state: 'ENDED',
        summaryDrafted: false,
      },
      {
        ...fixtures.assignedConsultations[1],
        id: 'c-c',
        state: 'ENDED',
        summaryDrafted: true,
      },
    ]);
    const { findByText, getByText } = render();
    expect(await findByText('Start the session')).toBeInTheDocument();
    // An ended case with no saved draft would never reach a doctor — call it out.
    expect(getByText('Write the summary')).toBeInTheDocument();
    // The signed-in user is a doctor, so a drafted case is theirs to finalize.
    expect(getByText('Finalize the summary')).toBeInTheDocument();
  });

  it('reconciles live when a state or summary signal arrives', async () => {
    mock.getAssigned.mockResolvedValue([]);
    const { findByText } = render();
    await findByText(/no assigned consultations yet/i);
    mock.getAssigned.mockResolvedValue([fixtures.assignedConsultations[1]]);
    await act(async () => live.assigned?.());
    expect(await findByText('Start the session')).toBeInTheDocument();
  });

  it('flags a case a doctor returned for changes with a badge (ADR-0025)', async () => {
    mock.getAssigned.mockResolvedValue([
      {
        ...fixtures.assignedConsultations[1],
        id: 'c-9',
        state: 'ENDED',
        summaryFinalized: false,
        summaryChangesRequested: true,
      },
    ]);
    const { findByText } = render();
    expect(await findByText(/changes requested/i)).toBeInTheDocument();
  });

  it('does not show the changes-requested badge once the summary is finalized', async () => {
    mock.getAssigned.mockResolvedValue([
      {
        ...fixtures.assignedConsultations[0],
        summaryFinalized: true,
        summaryChangesRequested: true,
      },
    ]);
    const { user, findByRole, getByRole, queryByText } = render();
    await user.click(await findByRole('button', { name: /^all/i }));
    expect(getByRole('link', { name: /open room/i })).toBeInTheDocument();
    expect(queryByText(/changes requested/i)).not.toBeInTheDocument();
  });

  it('shows an empty state when the clinician has no assigned cases', async () => {
    mock.getAssigned.mockResolvedValue([]);
    const { findByText } = render();
    expect(await findByText(/no assigned consultations yet/i)).toBeInTheDocument();
  });

  it('surfaces an API error', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getAssigned.mockRejectedValueOnce(new ApiError(500, 'Failed to load your consultations'));
    const { findByText } = render();
    expect(await findByText(/failed to load your consultations/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    mock.getAssigned.mockResolvedValue(fixtures.assignedConsultations);
    const { container, findAllByRole } = render();
    await findAllByRole('link', { name: /open room/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
