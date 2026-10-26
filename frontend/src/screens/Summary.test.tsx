import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../lib/api';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import SummaryScreen from './Summary';

const mock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  finalizeSummary: vi.fn(),
  requestSummaryChanges: vi.fn(),
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

describe('Summary screen', () => {
  beforeEach(() => {
    mock.getSummary.mockReset();
    mock.finalizeSummary.mockReset();
    mock.requestSummaryChanges.mockReset();
  });

  it('renders a finalized summary', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { findByText, getByText } = render(fixtures.users.patient);
    expect(await findByText(/synthetic summary content/i)).toBeInTheDocument();
    expect(getByText(/finalized/i)).toBeInTheDocument();
  });

  it('shows the doctor a Finalize button for a draft and calls the API', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    mock.finalizeSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { user, findByRole } = render(fixtures.users.doctor);
    await user.click(await findByRole('button', { name: /finalize \(doctor only\)/i }));
    expect(mock.finalizeSummary).toHaveBeenCalledWith('c-1');
  });

  it('does not show a Finalize button to a patient', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { findByText, queryByRole } = render(fixtures.users.patient);
    await findByText(/draft — not yet finalized/i);
    expect(queryByRole('button', { name: /finalize/i })).not.toBeInTheDocument();
  });

  it('lets a doctor return a draft for changes with a note (ADR-0024)', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    mock.requestSummaryChanges.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { user, findByRole, findByLabelText, findByText } = render(fixtures.users.doctor);

    await user.type(await findByLabelText(/note for the drafter/i), 'Please add the BP reading.');
    await user.click(await findByRole('button', { name: /request changes/i }));

    expect(mock.requestSummaryChanges).toHaveBeenCalledWith('c-1', 'Please add the BP reading.');
    expect(await findByText(/returned to the drafter to revise/i)).toBeInTheDocument();
    // Requesting changes must not finalize.
    expect(mock.finalizeSummary).not.toHaveBeenCalled();
  });

  it('requests changes with no note when the field is left blank', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    mock.requestSummaryChanges.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { user, findByRole } = render(fixtures.users.doctor);
    await user.click(await findByRole('button', { name: /request changes/i }));
    expect(mock.requestSummaryChanges).toHaveBeenCalledWith('c-1', undefined);
  });

  it('does not show request-changes controls to a patient', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { findByText, queryByRole, queryByLabelText } = render(fixtures.users.patient);
    await findByText(/draft — not yet finalized/i);
    expect(queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
    expect(queryByLabelText(/note for the drafter/i)).not.toBeInTheDocument();
  });

  it('the doctor draft view (with request-changes controls) is axe-clean', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { container, findByLabelText } = render(fixtures.users.doctor);
    await findByLabelText(/note for the drafter/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('surfaces an error when the summary is unavailable', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getSummary.mockRejectedValue(new ApiError(404, 'Summary not available'));
    const { findByText } = render(fixtures.users.doctor);
    expect(await findByText(/summary not available/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { container, findByText } = render(fixtures.users.doctor);
    await findByText(/synthetic summary content/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
