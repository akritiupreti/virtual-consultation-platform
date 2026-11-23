import { JSX, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, Priority, QueueItem } from '../lib/api';
import { formatDuration, humanize, PRIORITIES, priorityLabel, severityLabel } from '../lib/format';
import { useDocumentTitle, useNow } from '../lib/hooks';
import { useQueueUpdates } from '../lib/realtime';

/**
 * The live triage queue (pre-claim view). Served in priority order, then
 * first-come-first-served; clinicians re-triage priority in place and claim a case
 * to open it. Only minimal intake shows before a claim (FR-7, invariant 6).
 */
export default function TriageQueue(): JSX.Element {
  const navigate = useNavigate();
  useDocumentTitle('Triage queue');
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Wait times are measured by the server (no client clock skew) and then counted
  // forward locally from when they were fetched, so they tick between refreshes.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const now = useNow(30000);

  const refresh = useCallback(async () => {
    try {
      setQueue(await api.getQueue());
      setFetchedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the queue');
    }
  }, []);

  // Live updates via WebSocket (ADR-0004); the slow interval is only a fallback
  // for when the socket is unavailable.
  useQueueUpdates(refresh);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function claim(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api.claim(id);
      navigate(`/consultations/${id}`);
    } catch (err) {
      // A lost race (409) just means someone else got it — say so and refresh.
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Another clinician claimed that case first. The queue has been refreshed.'
          : err instanceof ApiError
            ? err.message
            : 'Failed to claim',
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function reprioritize(id: string, priority: Priority): Promise<void> {
    setError(null);
    try {
      await api.setPriority(id, priority);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change priority');
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Triage queue</h1>
          <p className="muted">
            Pre-claim view — minimal information only. Full detail unlocks after you claim a case.
          </p>
        </div>
        {queue !== null && (
          <p className="header-stat" aria-live="polite">
            <strong>{queue.length}</strong> waiting
          </p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="card card-flush">
        {queue === null && !error ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : !queue || queue.length === 0 ? (
          <p className="muted empty">The queue is empty. New requests appear here automatically.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Priority</th>
                  <th scope="col">Complaint</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.id} className={`row-${item.priority.toLowerCase()}`}>
                    <td>
                      <select
                        className={`priority-select pill-${item.priority.toLowerCase()}`}
                        value={item.priority}
                        onChange={(e) => void reprioritize(item.id, e.target.value as Priority)}
                        aria-label={`Change priority (currently ${priorityLabel(item.priority)})`}
                      >
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {priorityLabel(p)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="cell-text">
                      <div className="cell-primary">{item.complaintSummary}</div>
                      <div className="muted">{humanize(item.symptomCategory)}</div>
                    </td>
                    <td className="nowrap">{severityLabel(item.severity)}</td>
                    <td className="nowrap">
                      {formatDuration(item.waitingSeconds + Math.max(0, now - fetchedAt) / 1000)}
                    </td>
                    <td className="cell-actions">
                      <button
                        className="btn-sm"
                        disabled={busyId !== null}
                        onClick={() => void claim(item.id)}
                      >
                        {busyId === item.id ? 'Claiming…' : 'Claim'}
                      </button>
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
