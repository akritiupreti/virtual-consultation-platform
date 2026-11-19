import { JSX, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BackButton from '../components/BackButton';
import { ApiError, api, Summary } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';

/**
 * The clinical summary record. Once a doctor finalizes it the text is immutable
 * (FR-13). Sign-off itself happens in the consultation room, next to the intake,
 * so it is never done blind.
 */
export default function SummaryScreen(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  useDocumentTitle('Clinical summary');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isClinician = user?.role === 'NURSE' || user?.role === 'DOCTOR';

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api.getSummary(id));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This summary is not available yet. It appears here once a doctor has signed it off.'
          : err instanceof ApiError
            ? err.message
            : 'Summary not available',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The room is open to its participants; a doctor who only signed the case off
  // keeps access to this record (ADR-0020) but not to the room.
  const canOpenRoom = user?.role === 'PATIENT' || (!!summary && summary.draftedBy === user?.id);

  return (
    <>
      <BackButton />
      <div className="page-header">
        <div>
          <h1>Clinical summary</h1>
          {summary && (
            <p className="muted">
              {summary.finalized
                ? `Finalized ${formatDateTime(summary.finalizedAt)}`
                : 'Draft — not yet finalized'}
            </p>
          )}
        </div>
        <div className="actions no-print">
          {canOpenRoom && (
            <Link className="btn-link btn-outline" to={`/consultations/${id}`}>
              Open consultation
            </Link>
          )}
          {summary?.finalized && (
            <button type="button" className="secondary" onClick={() => window.print()}>
              Print
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {summary && (
        <section className="card" aria-labelledby="summary-heading">
          <h2 id="summary-heading" className="sr-only">
            Summary
          </h2>
          <pre className="summary-text">{summary.content}</pre>
          {!summary.finalized && isClinician && (
            <p className="banner banner-info no-print">
              {user?.role === 'DOCTOR'
                ? 'This draft is awaiting sign-off. Review and sign it in the consultation room, alongside the intake.'
                : 'This draft is awaiting a doctor’s sign-off. Edit it in the consultation room.'}{' '}
              <Link to={`/consultations/${id}`}>Go to the consultation</Link>
            </p>
          )}
        </section>
      )}
    </>
  );
}
