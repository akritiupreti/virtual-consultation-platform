import { JSX, useCallback, useEffect, useState } from 'react';
import { ApiError, api, AuditEntry } from '../lib/api';

export default function AdminAudit(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await api.getAudit());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the audit log');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        System activity only — who, what, and when. No clinical content (messages, attachments,
        summaries) is ever shown here (separation of duties).
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card">
        {entries.length === 0 ? (
          <p className="muted">No audit events yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Consultation</th>
                <th>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.eventType}</td>
                  <td className="muted">{e.actorId?.slice(0, 8) ?? '—'}</td>
                  <td className="muted">{e.consultationId?.slice(0, 8) ?? '—'}</td>
                  <td className="muted">{e.metadata ? JSON.stringify(e.metadata) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
