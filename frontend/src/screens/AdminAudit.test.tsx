import { within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import AdminAudit from './AdminAudit';

const mock = vi.hoisted(() => ({ getAudit: vi.fn(), getUsers: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});

function page(items: typeof fixtures.audit) {
  return { items, total: items.length, limit: 50, offset: 0 };
}

function render() {
  return renderWithProviders(<AdminAudit />, { user: fixtures.users.admin, route: '/audit' });
}

describe('AdminAudit screen', () => {
  beforeEach(() => {
    mock.getAudit.mockReset().mockResolvedValue(page(fixtures.audit));
    mock.getUsers.mockReset().mockResolvedValue(fixtures.userAccounts);
  });

  it('renders audit rows (who/what/when only) with readable events and actors', async () => {
    const { findByText, getByText, getByRole, findAllByText } = render();
    expect(await findByText('Consultation claimed')).toBeInTheDocument();
    expect(within(getByRole('table')).getByText('Summary finalized')).toBeInTheDocument();
    // Actor ids resolve to the account email the admin already manages.
    expect((await findAllByText('doctor@example.test')).length).toBeGreaterThan(0);
    // Separation-of-duties notice is always present (invariant 3).
    expect(getByText(/no clinical content/i)).toBeInTheDocument();
  });

  it('renders metadata as readable key/value pairs with a short trace id', async () => {
    mock.getAudit.mockResolvedValue(
      page([
        {
          ...fixtures.audit[0],
          eventType: 'SUMMARY_FINALIZED',
          metadata: { correlationId: '9f1c2d3e-0000-4000-8000-000000000000', draftedBy: 'u-nurse' },
        },
      ]),
    );
    const { findAllByText, queryByText, getByTitle } = render();
    expect((await findAllByText('nurse@example.test')).length).toBeGreaterThan(0);
    // The trace id is shortened for reading; the full value stays on hover.
    expect(getByTitle('9f1c2d3e-0000-4000-8000-000000000000')).toHaveTextContent('9f1c2d3e');
    expect(queryByText('9f1c2d3e-0000-4000-8000-000000000000')).not.toBeInTheDocument();
  });

  it('applies filters server-side and resets to the first page', async () => {
    const { user, findByText, getByLabelText, getByRole } = render();
    await findByText('Consultation claimed');
    await user.selectOptions(getByLabelText(/^event$/i), 'SUMMARY_FINALIZED');
    await user.click(getByRole('button', { name: /apply/i }));
    expect(mock.getAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'SUMMARY_FINALIZED', offset: 0, limit: 50 }),
    );
  });

  it('rejects a partial consultation id before querying', async () => {
    const { user, findByText, getByLabelText, getByRole } = render();
    await findByText('Consultation claimed');
    const calls = mock.getAudit.mock.calls.length;
    await user.type(getByLabelText(/consultation id/i), 'c-1');
    await user.click(getByRole('button', { name: /apply/i }));
    expect(await findByText(/must be a full id/i)).toBeInTheDocument();
    expect(mock.getAudit.mock.calls.length).toBe(calls);
  });

  it('pages through older events', async () => {
    mock.getAudit.mockResolvedValue({ items: fixtures.audit, total: 120, limit: 50, offset: 0 });
    const { user, findByRole } = render();
    await user.click(await findByRole('button', { name: /older/i }));
    expect(mock.getAudit).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }));
  });

  it('shows an empty state when there are no events', async () => {
    mock.getAudit.mockResolvedValue(page([]));
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
    await findByText('Consultation claimed');
    expect(await axe(container)).toHaveNoViolations();
  });
});
