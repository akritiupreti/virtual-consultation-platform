import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import AdminAudit from './AdminAudit';

const mock = vi.hoisted(() => ({ getAudit: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});

function render() {
  return renderWithProviders(<AdminAudit />, { user: fixtures.users.admin, route: '/audit' });
}

describe('AdminAudit screen', () => {
  beforeEach(() => {
    mock.getAudit.mockReset().mockResolvedValue(fixtures.audit);
  });

  it('renders audit rows (who/what/when only)', async () => {
    const { findByText, getByText } = render();
    expect(await findByText('CONSULTATION_CLAIMED')).toBeInTheDocument();
    expect(getByText('SUMMARY_FINALIZED')).toBeInTheDocument();
    // Separation-of-duties notice is always present (invariant 3).
    expect(getByText(/no clinical content/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no events', async () => {
    mock.getAudit.mockResolvedValue([]);
    const { findByText } = render();
    expect(await findByText(/no audit events yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getAudit.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    const { findByText } = render();
    expect(await findByText(/forbidden/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByText } = render();
    await findByText('CONSULTATION_CLAIMED');
    expect(await axe(container)).toHaveNoViolations();
  });
});
