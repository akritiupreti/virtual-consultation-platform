import { FormEvent, JSX, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, ConsultationDetail, Message } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function ConsultationRoom(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const [detail, setDetail] = useState<ConsultationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isClinician = user?.role === 'NURSE' || user?.role === 'DOCTOR';
  const isDoctor = user?.role === 'DOCTOR';

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await api.getConsultation(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load consultation');
    }
  }, [id]);

  const loadMessages = useCallback(async () => {
    try {
      setMessages(await api.getMessages(id));
    } catch {
      /* messages may be briefly unavailable; keep the last view */
    }
  }, [id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    void loadMessages();
    const timer = setInterval(() => void loadMessages(), 3000);
    return () => clearInterval(timer);
  }, [loadMessages]);

  // Prefill an existing draft for the clinician (ignore if none / not permitted).
  useEffect(() => {
    if (!isClinician) {
      return;
    }
    api
      .getSummary(id)
      .then((s) => setDraft(s.content))
      .catch(() => undefined);
  }, [id, isClinician]);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await fn();
      await loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!text.trim()) {
      return;
    }
    setError(null);
    try {
      await api.sendMessage(id, text.trim());
      setText('');
      await loadMessages();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send');
    }
  }

  if (!detail) {
    return <p className="muted">{error ?? 'Loading…'}</p>;
  }

  const inSession = detail.state === 'IN_SESSION';
  const canDraft =
    isClinician && (inSession || detail.state === 'ENDED') && !detail.summaryFinalized;

  return (
    <>
      <div className="row">
        <h1 style={{ marginRight: 12 }}>Consultation</h1>
        <span className={`tier-${detail.priority}`}>{detail.priority}</span>
        <span className="badge" style={{ marginLeft: 8 }}>
          {detail.state}
        </span>
      </div>
      {error && <p className="error">{error}</p>}

      {detail.intake && (
        <div className="card">
          <h2>Intake</h2>
          <p>
            <strong>{detail.intake.chiefComplaint}</strong>
          </p>
          <p className="muted">
            {detail.intake.symptomCategory} · onset {detail.intake.onsetDuration} · severity{' '}
            {detail.intake.severity}/5
          </p>
          {detail.intake.history && <p>History: {detail.intake.history}</p>}
          {detail.intake.medications && <p>Medications: {detail.intake.medications}</p>}
        </div>
      )}

      {isClinician && (
        <div className="card">
          <h2>Clinician controls</h2>
          <div className="inline">
            {detail.state === 'CLAIMED' && (
              <button onClick={() => void act(() => api.start(id))}>Start session</button>
            )}
            {inSession && (
              <button onClick={() => void act(() => api.complete(id))}>Complete</button>
            )}
            {isDoctor && detail.state === 'ENDED' && !detail.summaryFinalized && (
              <button onClick={() => void act(() => api.finalizeSummary(id))}>
                Finalize summary
              </button>
            )}
            {detail.summaryFinalized && (
              <Link to={`/consultations/${id}/summary`}>View finalized summary</Link>
            )}
          </div>

          {canDraft && (
            <div style={{ marginTop: 12 }}>
              <label htmlFor="draft">Summary draft</label>
              <textarea id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div style={{ marginTop: 8 }}>
                <button
                  className="secondary"
                  disabled={!draft.trim()}
                  onClick={() => void act(() => api.draftSummary(id, draft.trim()))}
                >
                  Save draft
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Messages</h2>
        <div className="messages">
          {messages.length === 0 && <p className="muted">No messages yet.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`msg${m.senderId === user?.id ? ' mine' : ''}`}>
              <div>{m.body}</div>
              <div className="meta">{new Date(m.createdAt).toLocaleTimeString()}</div>
            </div>
          ))}
        </div>
        <form onSubmit={send} className="row" style={{ marginTop: 12 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              inSession ? 'Type a message…' : 'Messaging is open during the session only'
            }
            disabled={!inSession}
            maxLength={4000}
          />
          <button type="submit" disabled={!inSession || !text.trim()}>
            Send
          </button>
        </form>
      </div>

      {detail.summaryFinalized && user?.role === 'PATIENT' && (
        <Link to={`/consultations/${id}/summary`}>View your summary</Link>
      )}
    </>
  );
}
