import { JSX, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, Priority, QueueItem } from '../lib/api';
import { useQueueUpdates } from '../lib/realtime';

export default function TriageQueue(): JSX.Element {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setQueue(await api.getQueue());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the queue');
    }
  }, []);

  // Live updates via WebSocket (ADR-0009); the slow interval is only a fallback
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
      // A lost race (409) just means someone else got it — refresh the queue.
      setError(err instanceof ApiError ? err.message : 'Failed to claim');
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function reprioritize(id: string, priority: Priority): Promise<void> {
    try {
      await api.setPriority(id, priority);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change priority');
    }
  }

  return (
    <>
      <h1>Triage queue</h1>
      <p className="muted">
        Pre-claim view — minimal information only. Full detail unlocks after you claim a case.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card">
        {queue.length === 0 ? (
          <p className="muted">The queue is empty.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Category</th>
                <th>Severity</th>
                <th>Complaint</th>
                <th>Waiting</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td>
                    <select
                      value={item.priority}
                      onChange={(e) => void reprioritize(item.id, e.target.value as Priority)}
                      aria-label="Change priority"
                    >
                      <option value="ROUTINE">Routine</option>
                      <option value="URGENT">Urgent</option>
                      <option value="EMERGENCY">Emergency</option>
                    </select>
                  </td>
                  <td>{item.symptomCategory}</td>
                  <td>{item.severity}</td>
                  <td>{item.complaintSummary}</td>
                  <td>{Math.round(item.waitingSeconds / 60)} min</td>
                  <td>
                    <button disabled={busyId === item.id} onClick={() => void claim(item.id)}>
                      {busyId === item.id ? 'Claiming…' : 'Claim'}
                    </button>
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
