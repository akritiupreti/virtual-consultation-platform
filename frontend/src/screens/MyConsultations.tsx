import { JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pill, PriorityBadge, StateBadge } from '../components/Badges';
import { ApiError, api, AssignedConsultation } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, humanize } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useAssignedUpdates } from '../lib/realtime';

type Filter = 'active' | 'completed' | 'all';

const DONE_STATES = new Set(['SUMMARIZED', 'CANCELLED']);

interface NextStep {
  text: string;
  tone?: 'attention' | 'info' | 'success' | 'muted';
}

/**
 * What the clinician has to do next on a case — the list's main job. An ENDED
 * case with no saved draft is called out explicitly: without a draft it cannot
 * reach a doctor's sign-off list (ADR-0018), so it must not go unnoticed.
 */
export function nextStepFor(c: AssignedConsultation, isDoctor: boolean): NextStep {
  switch (c.state) {
    case 'CLAIMED':
      return { text: 'Start the session', tone: 'info' };
    case 'IN_SESSION':
      return { text: 'Session in progress', tone: 'info' };
    case 'ENDED':
      if (c.summaryFinalized) {
        return { text: 'Summary finalized', tone: 'success' };
      }
      if (!c.summaryDrafted) {
        return { text: 'Write the summary', tone: 'attention' };
      }
      return isDoctor
        ? { text: 'Finalize the summary', tone: 'attention' }
        : { text: 'Awaiting doctor sign-off' };
    case 'SUMMARIZED':
      return { text: 'Complete', tone: 'success' };
    case 'CANCELLED':
      return { text: 'Cancelled by the patient', tone: 'muted' };
    default:
      return { text: '—' };
  }
}

/**
 * A clinician's own assigned cases — the way back to a consultation room or its
 * finalised summary without the URL. The triage queue only lists *unclaimed*
 * cases, so once a clinician claims one this is where they return to it. Updates
 * live: state changes and summary signals reach the assigned clinician's personal
 * room (ADR-0022).
 */
export default function MyConsultations(): JSX.Element {
  const { user } = useAuth();
  useDocumentTitle('My consultations');
  const [cases, setCases] = useState<AssignedConsultation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('active');

  const refresh = useCallback(async () => {
    try {
      setCases(await api.getAssigned());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load your consultations');
    }
  }, []);

  useAssignedUpdates(refresh);
  // Slow fallback in case the socket is unavailable.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [refresh]);

  const isDoctor = user?.role === 'DOCTOR';
  const all = cases ?? [];
  const active = all.filter((c) => !DONE_STATES.has(c.state));
  const completed = all.filter((c) => DONE_STATES.has(c.state));
  const shown = filter === 'active' ? active : filter === 'completed' ? completed : all;

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'active', label: 'Active', count: active.length },
    { key: 'completed', label: 'Completed', count: completed.length },
    { key: 'all', label: 'All', count: all.length },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>My consultations</h1>
          <p className="muted">Cases you have claimed. Unclaimed cases are in the triage queue.</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="segmented" role="group" aria-label="Filter consultations">
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
        {cases === null && !error ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : all.length === 0 ? (
          <p className="muted empty">
            You have no assigned consultations yet. Claim a case from the{' '}
            <Link to="/queue">triage queue</Link>.
          </p>
        ) : shown.length === 0 ? (
          <p className="muted empty">
            {filter === 'active'
              ? 'Nothing needs your attention right now.'
              : 'No consultations here.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Complaint</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Status</th>
                  <th scope="col">Next step</th>
                  <th scope="col">Claimed</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const step = nextStepFor(c, isDoctor);
                  return (
                    <tr key={c.id}>
                      <td className="cell-text">
                        <div className="cell-primary">{c.complaintSummary || '—'}</div>
                        <div className="muted">{humanize(c.symptomCategory)}</div>
                      </td>
                      <td>
                        <PriorityBadge priority={c.priority} />
                      </td>
                      <td>
                        <StateBadge state={c.state} />
                      </td>
                      <td>{step.tone ? <Pill tone={step.tone}>{step.text}</Pill> : step.text}</td>
                      <td className="nowrap">{formatDateTime(c.claimedAt)}</td>
                      <td className="cell-actions">
                        <Link className="btn-link btn-sm" to={`/consultations/${c.id}`}>
                          Open room
                        </Link>
                        {c.summaryFinalized && (
                          <Link
                            className="btn-link btn-outline btn-sm"
                            to={`/consultations/${c.id}/summary`}
                          >
                            View summary
                          </Link>
                        )}
                      </td>
                    </tr>
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
