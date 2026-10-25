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
    try {
      await api.finalizeSummary(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to finalize');
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

      {summary && (
        <div className="card">
          <p className="muted">
            {summary.finalized
              ? `Finalized${summary.finalizedAt ? ` on ${new Date(summary.finalizedAt).toLocaleString()}` : ''}`
              : 'Draft — not yet finalized'}
          </p>
          <pre>{summary.content}</pre>
          {user?.role === 'DOCTOR' && !summary.finalized && (
            <button onClick={() => void finalize()}>Finalize (doctor only)</button>
          )}
        </div>
      )}
    </>
  );
}
