import { JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pill, PriorityBadge } from '../components/Badges';
import { ApiError, api, type PendingSignoff } from '../lib/api';
import { formatDateTime, humanize, timeAgo } from '../lib/format';
import { useDocumentTitle, useNow } from '../lib/hooks';
import { useSummaryUpdates } from '../lib/realtime';

/**
 * A doctor's "pending sign-off" worklist (ADR-0020): cases ended with a drafted,
 * unfinalized summary — typically run by a nurse, with no doctor participant, so
 * they appear in neither the triage queue (QUEUED-only) nor "My consultations"
 * (own claims only). Each row opens the room, where the doctor reviews the intake
 * and draft and finalizes or returns it. Updates live for every doctor (ADR-0027).
 */
export default function PendingSignoff(): JSX.Element {
  useDocumentTitle('Pending sign-off');
  const [cases, setCases] = useState<PendingSignoff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      setCases(await api.getPendingSignoff());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load cases awaiting sign-off');
    }
  }, []);

  useSummaryUpdates(() => void refresh());
  // Slow fallback in case the socket is unavailable.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [refresh]);

  const list = cases ?? [];
  const ready = list.filter((c) => !c.changesRequested).length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Pending sign-off</h1>
          <p className="muted">
            Ended consultations with a saved summary draft that a doctor has not yet finalized.
          </p>
        </div>
        {cases !== null && (
          <p className="header-stat" aria-live="polite">
            <strong>{ready}</strong> ready to review
          </p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="card card-flush">
        {cases === null && !error ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : list.length === 0 ? (
          <p className="muted empty">No consultations are awaiting sign-off.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Complaint</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Ended</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td className="cell-text">
                      <div className="cell-primary">{c.complaintSummary || '—'}</div>
                      <div className="muted">{humanize(c.symptomCategory)}</div>
                    </td>
                    <td>
                      <PriorityBadge priority={c.priority} />
                    </td>
                    <td className="nowrap">
                      <div>{formatDateTime(c.endedAt)}</div>
                      <div className="muted">{timeAgo(c.endedAt, now)}</div>
                    </td>
                    <td>
                      {c.changesRequested ? (
                        <Pill tone="attention">Returned to drafter</Pill>
                      ) : (
                        <Pill tone="info">Ready to review</Pill>
                      )}
                    </td>
                    <td className="cell-actions">
                      <Link className="btn-link btn-sm" to={`/consultations/${c.id}`}>
                        Review &amp; sign off
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
