import { FormEvent, JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, MyConsultation, Priority } from '../lib/api';
import { usePatientUpdates } from '../lib/realtime';

const CATEGORIES = [
  'GENERAL',
  'RESPIRATORY',
  'CARDIAC',
  'GASTROINTESTINAL',
  'MUSCULOSKELETAL',
  'DERMATOLOGY',
  'NEUROLOGICAL',
  'MENTAL_HEALTH',
  'OTHER',
];

const OPEN_ROOM_STATES = new Set(['CLAIMED', 'IN_SESSION', 'ENDED', 'SUMMARIZED']);
const CANCELLABLE = new Set(['REQUESTED', 'QUEUED', 'CLAIMED']);

export default function PatientHome(): JSX.Element {
  const [mine, setMine] = useState<MyConsultation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [chiefComplaint, setChiefComplaint] = useState('');
  const [symptomCategory, setSymptomCategory] = useState(CATEGORIES[0]);
  const [onsetDuration, setOnsetDuration] = useState('');
  const [severity, setSeverity] = useState(3);
  const [priority, setPriority] = useState<Priority>('ROUTINE');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMine(await api.getMine());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load your consultations');
    }
  }, []);

  // Live position / state pushes (ADR-0009); slow interval is a fallback only.
  usePatientUpdates(refresh);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.submitRequest({
        chiefComplaint,
        symptomCategory,
        onsetDuration,
        severity,
        consent,
        priority,
      });
      setChiefComplaint('');
      setOnsetDuration('');
      setSeverity(3);
      setPriority('ROUTINE');
      setConsent(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit request');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await api.cancel(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to cancel');
    }
  }

  return (
    <>
      <h1>My consultations</h1>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Request a consultation</h2>
        <form onSubmit={submit}>
          <label htmlFor="cc">Chief complaint</label>
          <input
            id="cc"
            value={chiefComplaint}
            onChange={(e) => setChiefComplaint(e.target.value)}
            required
            minLength={3}
            maxLength={2000}
          />
          <div className="row" style={{ gap: 16 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="cat">Symptom category</label>
              <select
                id="cat"
                value={symptomCategory}
                onChange={(e) => setSymptomCategory(e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="onset">Onset / duration</label>
              <input
                id="onset"
                value={onsetDuration}
                onChange={(e) => setOnsetDuration(e.target.value)}
                required
                placeholder="e.g. 2 days"
              />
            </div>
          </div>
          <div className="row" style={{ gap: 16 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="sev">Severity (1–5)</label>
              <select
                id="sev"
                value={severity}
                onChange={(e) => setSeverity(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="prio">Suggested priority</label>
              <select
                id="prio"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                <option value="ROUTINE">Routine</option>
                <option value="URGENT">Urgent</option>
                <option value="EMERGENCY">Emergency</option>
              </select>
            </div>
          </div>
          <label className="row" style={{ marginTop: 12, gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>I consent to the processing of my clinical data for this consultation.</span>
          </label>
          <div style={{ marginTop: 14 }}>
            <button type="submit" disabled={busy || !consent}>
              {busy ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Status</h2>
        {mine.length === 0 ? (
          <p className="muted">No consultations yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>Priority</th>
                <th>Queue</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((c) => (
                <tr key={c.id}>
                  <td>{c.state}</td>
                  <td className={`tier-${c.priority}`}>{c.priority}</td>
                  <td>
                    {c.state === 'QUEUED' && c.position !== null
                      ? `${c.position} ahead of you`
                      : '—'}
                  </td>
                  <td className="inline">
                    {OPEN_ROOM_STATES.has(c.state) && (
                      <Link to={`/consultations/${c.id}`}>Open room</Link>
                    )}
                    {c.summaryAvailable && (
                      <Link to={`/consultations/${c.id}/summary`}>View summary</Link>
                    )}
                    {CANCELLABLE.has(c.state) && (
                      <button className="link-btn" onClick={() => void cancel(c.id)}>
                        Cancel
                      </button>
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
