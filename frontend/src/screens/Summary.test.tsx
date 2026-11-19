import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../lib/api';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import SummaryScreen from './Summary';

const mock = vi.hoisted(() => ({
  getSummary: vi.fn(),
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

describe('Summary screen', () => {
  beforeEach(() => {
    mock.getSummary.mockReset();
    mock.finalizeSummary.mockReset();
  });

  it('renders a finalized summary with its date', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { findByText, getByText } = render(fixtures.users.patient);
    expect(await findByText(/synthetic summary content/i)).toBeInTheDocument();
    expect(getByText(/^finalized/i)).toBeInTheDocument();
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

  it('does not show sign-off controls to a patient on a draft', async () => {
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    const { findByText, queryByRole } = render(fixtures.users.patient);
    await findByText(/draft — not yet finalized/i);
    expect(queryByRole('button', { name: /finalize/i })).not.toBeInTheDocument();
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
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { container, findByText } = render(fixtures.users.doctor);
    await findByText(/synthetic summary content/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
