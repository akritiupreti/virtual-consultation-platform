import { JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type PendingSignoff } from '../lib/api';

/**
 * A doctor's "pending sign-off" worklist (ADR-0020): cases ended with a drafted,
 * unfinalized summary — typically run by a nurse, with no doctor participant, so
 * they appear in neither the triage queue (QUEUED-only) nor "My consultations"
 * (own claims only). Each row opens the room, where the one-click "Finalize & sign
 * off" flow (ConsultationRoom) reviews the draft and finalizes it.
 */
export default function PendingSignoff(): JSX.Element {
  const [cases, setCases] = useState<PendingSignoff[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCases(await api.getPendingSignoff());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load cases awaiting sign-off');
    }
  }, []);

  // Light polling keeps the worklist fresh as nurses end and draft new cases.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <h1>Pending sign-off</h1>
      <p className="muted">
        Consultations awaiting a doctor&apos;s sign-off — a summary has been drafted but not yet
        finalized. Open a case to review it and finalize.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card">
        {cases.length === 0 ? (
          <p className="muted">No consultations are awaiting sign-off.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ended</th>
                <th>Priority</th>
                <th>Category</th>
                <th>Complaint</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td>{c.endedAt ? new Date(c.endedAt).toLocaleString() : '—'}</td>
                  <td className={`tier-${c.priority}`}>{c.priority}</td>
                  <td>{c.symptomCategory ?? '—'}</td>
                  <td>{c.complaintSummary || '—'}</td>
                  <td className="inline">
                    <Link to={`/consultations/${c.id}`}>Review &amp; sign off</Link>
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
