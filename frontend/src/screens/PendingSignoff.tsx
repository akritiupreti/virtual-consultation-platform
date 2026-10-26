import { JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pill, PriorityBadge } from '../components/Badges';
import { ApiError, api, Priority, type PendingSignoff, type SignedOff } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, humanize, timeAgo } from '../lib/format';
import { useDocumentTitle, useNow } from '../lib/hooks';
import { useSummaryUpdates } from '../lib/realtime';

type Filter = 'active' | 'completed' | 'all';

/** One row of either list, so "All" can show both side by side. */
interface Row {
  id: string;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  endedAt: string | null;
  status: 'ready' | 'returned' | 'signed';
  signedAt: string | null;
  draftedByMe: boolean;
}

/**
 * A doctor's sign-off worklist (ADR-0020) and their own sign-off history
 * (ADR-0029). **Active** is every ended case with a saved, unfinalized draft —
 * typically nurse-run, so it appears in neither the triage queue nor "My
 * consultations"; each opens the room to review and finalize or return it.
 * **Completed** is the cases this doctor signed off, kept so a final review never
 * disappears once it is done; each opens the signed summary (ADR-0023). Both
 * lists update live for every doctor (ADR-0027).
 */
export default function PendingSignoff(): JSX.Element {
  const { user } = useAuth();
  useDocumentTitle('Pending sign-off');
  const [pending, setPending] = useState<PendingSignoff[] | null>(null);
  const [signed, setSigned] = useState<SignedOff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('active');
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.getPendingSignoff(), api.getSignedOff()]);
      setPending(p);
      setSigned(s);
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

  const active: Row[] = (pending ?? []).map((c) => ({
    id: c.id,
    priority: c.priority,
    symptomCategory: c.symptomCategory,
    complaintSummary: c.complaintSummary,
    endedAt: c.endedAt,
    status: c.changesRequested ? 'returned' : 'ready',
    signedAt: null,
    draftedByMe: c.draftedBy === user?.id,
  }));
  const completed: Row[] = (signed ?? []).map((c) => ({
    id: c.id,
    priority: c.priority,
    symptomCategory: c.symptomCategory,
    complaintSummary: c.complaintSummary,
    endedAt: c.endedAt,
    status: 'signed',
    signedAt: c.finalizedAt,
    draftedByMe: c.draftedBy === user?.id,
  }));
  const shown =
    filter === 'active' ? active : filter === 'completed' ? completed : [...active, ...completed];
  const ready = active.filter((r) => r.status === 'ready').length;
  const loading = pending === null && !error;

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'active', label: 'Active', count: active.length },
    { key: 'completed', label: 'Completed', count: completed.length },
    { key: 'all', label: 'All', count: active.length + completed.length },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Pending sign-off</h1>
          <p className="muted">
            Ended consultations with a saved summary draft awaiting a doctor, and the ones you have
            signed off.
          </p>
        </div>
        {pending !== null && (
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

      <div className="segmented" role="group" aria-label="Filter sign-offs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={filter === t.key}
            onClick={() => setFilter(t.key)}
          >
            {t.label} <span className="count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="card card-flush">
        {loading ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : shown.length === 0 ? (
          <p className="muted empty">
            {filter === 'active'
              ? 'No consultations are awaiting sign-off.'
              : filter === 'completed'
                ? 'You have not signed off any consultations yet.'
                : 'Nothing to show yet.'}
          </p>
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
                {shown.map((r) => (
                  <tr key={`${r.status}-${r.id}`}>
                    <td className="cell-text">
                      <div className="cell-primary">{r.complaintSummary || '—'}</div>
                      <div className="muted">
                        {humanize(r.symptomCategory)}
                        {r.status === 'signed' &&
                          !r.draftedByMe &&
                          ' · drafted by another clinician'}
                      </div>
                    </td>
                    <td>
                      <PriorityBadge priority={r.priority} />
                    </td>
                    <td className="nowrap">
                      <div>{formatDateTime(r.endedAt)}</div>
                      {r.status !== 'signed' && (
                        <div className="muted">{timeAgo(r.endedAt, now)}</div>
                      )}
                    </td>
                    <td>
                      {r.status === 'returned' && <Pill tone="attention">Returned to drafter</Pill>}
                      {r.status === 'ready' && <Pill tone="info">Ready to review</Pill>}
                      {r.status === 'signed' && (
                        <>
                          <Pill tone="success">Signed off</Pill>
                          <div className="muted">{formatDateTime(r.signedAt)}</div>
                        </>
                      )}
                    </td>
                    <td className="cell-actions">
                      {r.status === 'signed' ? (
                        <Link
                          className="btn-link btn-outline btn-sm"
                          to={`/consultations/${r.id}/summary`}
                        >
                          View summary
                        </Link>
                      ) : (
                        <Link className="btn-link btn-sm" to={`/consultations/${r.id}`}>
                          Review &amp; sign off
                        </Link>
                      )}
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
