import { Fragment, JSX, useCallback, useEffect, useState } from 'react';
import ConfirmPanel from '../components/ConfirmPanel';
import { ApiError, api, Role, UserAccount, UserStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, roleLabel } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';

const ROLES: Role[] = ['PATIENT', 'NURSE', 'DOCTOR', 'ADMIN'];

/**
 * Admin-only user management (FR-14, FR-23/24/25). Lists every account and lets an
 * admin deactivate / reactivate others. Separation of duties (invariant 3): this
 * screen shows who/what only — never messages or summaries.
 */
export default function AdminUsers(): JSX.Element {
  const { user } = useAuth();
  useDocumentTitle('Users');
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');

  const load = useCallback(async () => {
    try {
      setUsers(await api.getUsers());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load users');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(target: UserAccount): Promise<void> {
    const deactivating = target.status === 'ACTIVE';
    setBusyId(target.id);
    setError(null);
    setNotice(null);
    try {
      const updated = deactivating
        ? await api.deactivateUser(target.id)
        : await api.reactivateUser(target.id);
      setNotice(
        `${updated.email} is now ${updated.status === 'ACTIVE' ? 'active' : 'deactivated'}.`,
      );
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  const all = users ?? [];
  const active = all.filter((u) => u.status === 'ACTIVE').length;
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (u) =>
      (!needle || u.email.toLowerCase().includes(needle)) &&
      (!role || u.role === role) &&
      (!status || u.status === status),
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p className="muted">
            Admins manage accounts only. No clinical content (messages or summaries) is ever shown
            here — separation of duties.
          </p>
        </div>
        {users !== null && (
          <p className="header-stat">
            <strong>{all.length}</strong> accounts · <strong>{active}</strong> active ·{' '}
            <strong>{all.length - active}</strong> deactivated
          </p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="card filters filters-compact" role="search" aria-label="Filter users">
        <div>
          <label htmlFor="u-search">Search by email</label>
          <input
            id="u-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="u-role">Role</label>
          <select id="u-role" value={role} onChange={(e) => setRole(e.target.value as Role | '')}>
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="u-status">Status</label>
          <select
            id="u-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as UserStatus | '')}
          >
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="DEACTIVATED">Deactivated</option>
          </select>
        </div>
      </div>

      <div className="card card-flush">
        {users === null && !error ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : all.length === 0 ? (
          <p className="muted empty">No accounts found.</p>
        ) : shown.length === 0 ? (
          <p className="muted empty">No accounts match these filters.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => {
                  const isSelf = u.id === user?.id;
                  const isActive = u.status === 'ACTIVE';
                  return (
                    <Fragment key={u.id}>
                      <tr>
                        <td className="cell-wrap">{u.email}</td>
                        <td>
                          <span className={`badge badge-${u.role.toLowerCase()}`}>
                            {roleLabel(u.role)}
                          </span>
                        </td>
                        <td>
                          <span className={`status status-${u.status.toLowerCase()}`}>
                            {isActive ? 'Active' : 'Deactivated'}
                          </span>
                        </td>
                        <td className="muted nowrap">{formatDate(u.createdAt)}</td>
                        <td className="cell-actions">
                          {isSelf ? (
                            <span className="muted">You</span>
                          ) : isActive ? (
                            <button
                              className="danger btn-sm"
                              disabled={busyId === u.id || confirmId === u.id}
                              onClick={() => setConfirmId(u.id)}
                            >
                              Deactivate
                            </button>
                          ) : (
                            <button
                              className="secondary btn-sm"
                              disabled={busyId === u.id}
                              onClick={() => void toggle(u)}
                            >
                              {busyId === u.id ? 'Working…' : 'Reactivate'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {confirmId === u.id && (
                        <tr className="confirm-row">
                          <td colSpan={5}>
                            <ConfirmPanel
                              label={`Confirm deactivate ${u.email}`}
                              confirmLabel="Deactivate account"
                              danger
                              busy={busyId === u.id}
                              onConfirm={() => void toggle(u)}
                              onCancel={() => setConfirmId(null)}
                            >
                              <p>
                                Deactivate <strong>{u.email}</strong>? They are signed out
                                immediately and cannot log in. Someone in a live consultation cannot
                                be deactivated until it ends.
                                {(u.role === 'NURSE' || u.role === 'DOCTOR') &&
                                  ' Cases they have claimed but not started return to the queue automatically.'}{' '}
                                You can reactivate the account later.
                              </p>
                            </ConfirmPanel>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
