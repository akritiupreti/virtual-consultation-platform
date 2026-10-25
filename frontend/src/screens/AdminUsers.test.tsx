import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import AdminUsers from './AdminUsers';

const mock = vi.hoisted(() => ({
  getUsers: vi.fn(),
  deactivateUser: vi.fn(),
  reactivateUser: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});

function render() {
  return renderWithProviders(<AdminUsers />, { user: fixtures.users.admin, route: '/users' });
}

describe('AdminUsers screen', () => {
  beforeEach(() => {
    mock.getUsers.mockReset().mockResolvedValue(fixtures.userAccounts);
    mock.deactivateUser.mockReset();
    mock.reactivateUser.mockReset();
  });

  it('lists accounts with role and status (no clinical content)', async () => {
    const { findByText, getByText } = render();
    expect(await findByText('nurse@example.test')).toBeInTheDocument();
    expect(getByText(/no clinical content/i)).toBeInTheDocument();
    // Counts: 3 total, 2 active, 1 deactivated.
    expect(getByText('Total accounts')).toBeInTheDocument();
  });

  it('marks the signed-in admin as "You" (cannot self-deactivate)', async () => {
    const { findByText } = render();
    await findByText('admin@example.test');
    expect(await findByText('You')).toBeInTheDocument();
  });

  it('deactivates an active user and shows a notice', async () => {
    mock.deactivateUser.mockResolvedValue({ ...fixtures.userAccounts[1], status: 'DEACTIVATED' });
    const { user, findByRole, findByText } = render();
    const btn = await findByRole('button', { name: /deactivate/i });
    await user.click(btn);
    expect(mock.deactivateUser).toHaveBeenCalledWith('u-nurse');
    expect(await findByText(/is now deactivated/i)).toBeInTheDocument();
  });

  it('reactivates a deactivated user', async () => {
    mock.reactivateUser.mockResolvedValue({ ...fixtures.userAccounts[2], status: 'ACTIVE' });
    const { user, findByRole } = render();
    const btn = await findByRole('button', { name: /reactivate/i });
    await user.click(btn);
    expect(mock.reactivateUser).toHaveBeenCalledWith('u-doctor');
  });

  it('surfaces a load error', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getUsers.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    const { findByText } = render();
    expect(await findByText(/forbidden/i)).toBeInTheDocument();
  });

  it('shows an action error when deactivation fails', async () => {
    const { ApiError } = await import('../lib/api');
    mock.deactivateUser.mockRejectedValueOnce(new ApiError(400, 'Cannot deactivate'));
    const { user, findByRole, findByText } = render();
    await user.click(await findByRole('button', { name: /deactivate/i }));
    expect(await findByText(/cannot deactivate/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no accounts', async () => {
    mock.getUsers.mockResolvedValue([]);
    const { findByText } = render();
    expect(await findByText(/no accounts found/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByText } = render();
    await findByText('nurse@example.test');
    expect(await axe(container)).toHaveNoViolations();
  });
});
