import { JSX, useCallback, useEffect, useState } from 'react';
import { ApiError, api, UserAccount } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Admin-only user management (FR-14, FR-23/24/25). Lists every account and lets an
 * admin deactivate / reactivate others. Separation of duties (invariant 3): this
 * screen shows who/what only — never messages, attachments, or summaries.
 */
export default function AdminUsers(): JSX.Element {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  const active = users.filter((u) => u.status === 'ACTIVE').length;

  return (
    <>
      <h1>User management</h1>
      <p className="muted">
        Admins manage accounts only. No clinical content (messages, attachments, summaries) is ever
        shown here — separation of duties.
      </p>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{users.length}</span>
          <span className="stat-label">Total accounts</span>
        </div>
        <div className="stat">
          <span className="stat-value">{active}</span>
          <span className="stat-label">Active</span>
        </div>
        <div className="stat">
          <span className="stat-value">{users.length - active}</span>
          <span className="stat-label">Deactivated</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        {users.length === 0 ? (
          <p className="muted">No accounts found.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === user?.id;
                return (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>
                      <span className={`badge badge-${u.role.toLowerCase()}`}>{u.role}</span>
                    </td>
                    <td>
                      <span className={`status status-${u.status.toLowerCase()}`}>
                        {u.status === 'ACTIVE' ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td className="muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>
                      {isSelf ? (
                        <span className="muted">You</span>
                      ) : (
                        <button
                          className={u.status === 'ACTIVE' ? 'danger' : 'secondary'}
                          disabled={busyId === u.id}
                          onClick={() => void toggle(u)}
                        >
                          {busyId === u.id
                            ? 'Working…'
                            : u.status === 'ACTIVE'
                              ? 'Deactivate'
                              : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
