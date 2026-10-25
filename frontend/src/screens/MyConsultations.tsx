import { JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, AssignedConsultation } from '../lib/api';

/**
 * A clinician's own assigned cases — the way back to a consultation room or its
 * finalised summary without the URL. The triage queue only lists *unclaimed*
 * cases, so once a clinician claims one this is where they return to it.
 */
export default function MyConsultations(): JSX.Element {
  const [cases, setCases] = useState<AssignedConsultation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCases(await api.getAssigned());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load your consultations');
    }
  }, []);

  // Light polling keeps state (e.g. a summary just finalised) reasonably fresh.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <h1>My consultations</h1>
      <p className="muted">Cases assigned to you. The triage queue only shows unclaimed cases.</p>
      {error && <p className="error">{error}</p>}

      <div className="card">
        {cases.length === 0 ? (
          <p className="muted">You have no assigned consultations yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Claimed</th>
                <th>Priority</th>
                <th>Category</th>
                <th>Complaint</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td>{c.claimedAt ? new Date(c.claimedAt).toLocaleString() : '—'}</td>
                  <td className={`tier-${c.priority}`}>{c.priority}</td>
                  <td>{c.symptomCategory ?? '—'}</td>
                  <td>{c.complaintSummary || '—'}</td>
                  <td>{c.state}</td>
                  <td className="inline">
                    <Link to={`/consultations/${c.id}`}>Open room</Link>
                    {c.summaryFinalized && (
                      <Link to={`/consultations/${c.id}/summary`}>View summary</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
