import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../lib/api';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import SummaryScreen from './Summary';

const mock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  addAddendum: vi.fn(),
  finalizeSummary: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});

function render(user: AuthUser) {
  return renderWithProviders(<SummaryScreen />, {
    user,
    route: '/consultations/c-1/summary',
    path: '/consultations/:id/summary',
  });
}

const addendum = {
  id: 'ad-1',
  authorId: 'u-doctor',
  content: 'Synthetic addendum text.',
  createdAt: '2026-10-22T10:00:00.000Z',
};

describe('Summary screen', () => {
  beforeEach(() => {
    mock.getSummary.mockReset();
    mock.addAddendum.mockReset();
    mock.finalizeSummary.mockReset();
  });

  it('renders a finalized summary with its date', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { findByText, getByText } = render(fixtures.users.patient);
    expect(await findByText(/synthetic summary content/i)).toBeInTheDocument();
    expect(getByText(/^finalized/i)).toBeInTheDocument();
  });

  it('lists addenda under the signed summary, read-only for the patient', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true, addenda: [addendum] }));
    const { findByText, queryByLabelText } = render(fixtures.users.patient);
    expect(await findByText('Synthetic addendum text.')).toBeInTheDocument();
    expect(queryByLabelText(/add an addendum/i)).not.toBeInTheDocument();
  });

  it('lets a clinician append an addendum to a finalized summary (FR-13)', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true, addenda: [] }));
    mock.addAddendum.mockResolvedValue(fixtures.summary({ finalized: true, addenda: [addendum] }));
    const { user, findByLabelText, getByRole, findByText } = render(fixtures.users.doctor);

    const field = await findByLabelText(/add an addendum/i);
    expect(getByRole('button', { name: /add addendum/i })).toBeDisabled();
    await user.type(field, 'Synthetic addendum text.');
    await user.click(getByRole('button', { name: /add addendum/i }));

    expect(mock.addAddendum).toHaveBeenCalledWith('c-1', 'Synthetic addendum text.');
    expect(await findByText(/addendum added to the record/i)).toBeInTheDocument();
    expect(await findByText('Synthetic addendum text.')).toBeInTheDocument();
  });

  it('sends a doctor to the consultation room to sign off a draft (no blind sign-off here)', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { findByText, findByRole, queryByRole } = render(fixtures.users.doctor);
    expect(await findByText(/awaiting sign-off/i)).toBeInTheDocument();
    expect(await findByRole('link', { name: /go to the consultation/i })).toHaveAttribute(
      'href',
      '/consultations/c-1',
    );
    expect(queryByRole('button', { name: /finalize/i })).not.toBeInTheDocument();
  });

  it('does not show sign-off or addendum controls to a patient on a draft', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { findByText, queryByRole, queryByLabelText } = render(fixtures.users.patient);
    await findByText(/draft — not yet finalized/i);
    expect(queryByRole('button', { name: /finalize|request changes/i })).not.toBeInTheDocument();
    expect(queryByLabelText(/add an addendum/i)).not.toBeInTheDocument();
  });

  it('explains when the summary is not available yet', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getSummary.mockRejectedValue(new ApiError(404, 'Summary not available'));
    const { findByText } = render(fixtures.users.patient);
    expect(await findByText(/not available yet/i)).toBeInTheDocument();
  });

  it('surfaces any other error', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getSummary.mockRejectedValue(new ApiError(500, 'Server unavailable'));
    const { findByText } = render(fixtures.users.doctor);
    expect(await findByText(/server unavailable/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true, addenda: [addendum] }));
    const { container, findByText } = render(fixtures.users.doctor);
    await findByText(/synthetic summary content/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
