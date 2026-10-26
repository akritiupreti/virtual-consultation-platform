import { FormEvent, JSX, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BackButton from '../components/BackButton';
import { ApiError, api, Summary } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';

/**
 * The clinical summary record. Once a doctor finalizes it the text is immutable;
 * clinicians correct it only by appending addenda, which are listed under the
 * signed summary for everyone who can read it (FR-13, C5). Sign-off itself happens
 * in the consultation room, next to the intake, so it is never done blind.
 */
export default function SummaryScreen(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  useDocumentTitle('Clinical summary');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addendum, setAddendum] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function addAddendum(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const content = addendum.trim();
    if (!content) {
      return;
    }
    setError(null);
    setNotice(null);
    setAdding(true);
    try {
      setSummary(await api.addAddendum(id, content));
      setAddendum('');
      setNotice('Addendum added to the record.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the addendum');
    } finally {
      setAdding(false);
    }
  }

  function authorLabel(authorId: string): string {
    if (authorId === user?.id) {
      return 'You';
    }
    return authorId === summary?.finalizedBy ? 'Signing doctor' : 'Clinician';
  }

  // The room is open to its participants; a doctor who only signed the case off
  // keeps access to this record (ADR-0023) but not to the room.
  const canOpenRoom = user?.role === 'PATIENT' || (!!summary && summary.draftedBy === user?.id);
  const addenda = summary?.addenda ?? [];

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
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {summary && (
        <>
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

          {summary.finalized && (
            <section className="card" aria-labelledby="addenda-heading">
              <h2 id="addenda-heading">Addenda</h2>
              {addenda.length === 0 ? (
                <p className="muted empty">No addenda. The summary stands as signed.</p>
              ) : (
                <ol className="addenda">
                  {addenda.map((a) => (
                    <li key={a.id}>
                      <div className="msg-meta">
                        <span className="msg-sender">{authorLabel(a.authorId)}</span>
                        <time dateTime={a.createdAt}>{formatDateTime(a.createdAt)}</time>
                      </div>
                      <p className="addendum-body">{a.content}</p>
                    </li>
                  ))}
                </ol>
              )}

              {isClinician && (
                <form onSubmit={addAddendum} className="no-print">
                  <label htmlFor="addendum">Add an addendum</label>
                  <textarea
                    id="addendum"
                    rows={3}
                    value={addendum}
                    maxLength={8000}
                    onChange={(e) => setAddendum(e.target.value)}
                    aria-describedby="addendum-hint"
                  />
                  <p className="hint" id="addendum-hint">
                    The signed summary cannot be edited. An addendum is appended permanently and is
                    visible to the patient.
                  </p>
                  <div className="actions">
                    <button type="submit" disabled={adding || !addendum.trim()}>
                      {adding ? 'Adding…' : 'Add addendum'}
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
