import { JSX, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BackButton from '../components/BackButton';
import { ApiError, api, Summary } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function SummaryScreen(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api.getSummary(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Summary not available');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function finalize(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await api.finalizeSummary(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to finalize');
    }
  }

  // Return the draft to its author to revise instead of signing it (ADR-0024). The
  // draft is unchanged, so there is nothing to reload; the optional note is sent to
  // the drafter in real time.
  async function requestChanges(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await api.requestSummaryChanges(id, note.trim() || undefined);
      setNote('');
      setNotice('Changes requested — the draft has been returned to the drafter to revise.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to request changes');
    }
  }

  return (
    <>
      <div className="row">
        <BackButton />
        <h1 style={{ marginRight: 12 }}>Clinical summary</h1>
        <Link to={`/consultations/${id}`}>Back to room</Link>
      </div>
      {error && <p className="error">{error}</p>}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {summary && (
        <div className="card">
          <p className="muted">
            {summary.finalized
              ? `Finalized${summary.finalizedAt ? ` on ${new Date(summary.finalizedAt).toLocaleString()}` : ''}`
              : 'Draft — not yet finalized'}
          </p>
          <pre>{summary.content}</pre>
          {user?.role === 'DOCTOR' && !summary.finalized && (
            <div className="signoff-actions">
              <label htmlFor="change-note">Note for the drafter (optional)</label>
              <textarea
                id="change-note"
                className="change-note"
                rows={3}
                value={note}
                maxLength={2000}
                placeholder="What should the drafter revise before this is signed?"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row" style={{ gap: 8 }}>
                <button onClick={() => void finalize()}>Finalize (doctor only)</button>
                <button className="secondary" onClick={() => void requestChanges()}>
                  Request changes
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
