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

function render() {
  return renderWithProviders(<MyConsultations />, {
    user: fixtures.users.doctor,
    route: '/assigned',
  });
}

describe('MyConsultations (clinician)', () => {
  beforeEach(() => mock.getAssigned.mockReset());

  it('lists assigned cases with a room link, and a summary link when finalized', async () => {
    mock.getAssigned.mockResolvedValue(fixtures.assignedConsultations);
    const { findAllByRole, getAllByRole } = render();

    const roomLinks = await findAllByRole('link', { name: /open room/i });
    expect(roomLinks).toHaveLength(2);
    expect(roomLinks[0]).toHaveAttribute('href', '/consultations/c-1');

    // Only the finalized case (c-1) exposes a summary link.
    const summaryLinks = getAllByRole('link', { name: /view summary/i });
    expect(summaryLinks).toHaveLength(1);
    expect(summaryLinks[0]).toHaveAttribute('href', '/consultations/c-1/summary');
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
