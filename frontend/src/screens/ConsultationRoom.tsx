import { FormEvent, JSX, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import BackButton from '../components/BackButton';
import { ApiError, api, ConsultationDetail, Message } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PresenceParticipant, useConsultationRoom } from '../lib/realtime';

export default function ConsultationRoom(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [detail, setDetail] = useState<ConsultationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [presence, setPresence] = useState<PresenceParticipant[]>([]);
  const [draft, setDraft] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Doctor "request changes" (ADR-0024): an optional note back to the drafter, and
  // a confirmation that the draft was returned.
  const [changeNote, setChangeNote] = useState('');
  const [changeNotice, setChangeNotice] = useState<string | null>(null);
  // A doctor's outstanding "please revise" request on this draft, for the drafter
  // (ADR-0025). Loaded with the draft, cleared once the drafter saves a revision.
  const [requestedChange, setRequestedChange] = useState<{ note: string | null } | null>(null);
  // Draft autosave status (the draft persists on its own — there is no Save button).
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // The last value successfully persisted, so we neither re-save an unchanged draft
  // nor re-persist the draft we just loaded from the server.
  const lastSaved = useRef('');

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

  // Live room: new messages, state changes, and participant presence (ADR-0009).
  // The slow interval is only a fallback for when the socket is unavailable.
  useConsultationRoom(id, {
    onMessage: (m) =>
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m])),
    onConsultationUpdated: () => void loadDetail(),
    onPresence: setPresence,
  });
  useEffect(() => {
    void loadMessages();
    const timer = setInterval(() => void loadMessages(), 15000);
    return () => clearInterval(timer);
  }, [loadMessages]);

  // Prefill an existing draft for the clinician (ignore if none / not permitted).
  // Record it as the last-saved value so autosave doesn't immediately re-persist it.
  useEffect(() => {
    if (!isClinician) {
      return;
    }
    api
      .getSummary(id)
      .then((s) => {
        setDraft(s.content);
        lastSaved.current = s.content.trim();
        setRequestedChange(s.changesRequestedAt ? { note: s.changesRequestedNote } : null);
      })
      .catch(() => undefined);
  }, [id, isClinician]);

  // Autosave the summary draft (replaces the old "Save draft" button): debounce
  // edits by the assigned clinician and persist them. This is also what surfaces a
  // nurse-run case on the doctor's sign-off dashboard — previously that needed an
  // explicit save, so a nurse who forgot to click stranded the case.
  useEffect(() => {
    if (!detail || !user) {
      return;
    }
    const assignedToMe = detail.claimedBy === user.id;
    const editable =
      assignedToMe &&
      (detail.state === 'IN_SESSION' || detail.state === 'ENDED') &&
      !detail.summaryFinalized;
    const trimmed = draft.trim();
    // Nothing to persist (empty), or unchanged since the last successful save.
    if (!editable || !trimmed || trimmed === lastSaved.current) {
      return;
    }
    setSaveState('saving');
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          await api.draftSummary(id, trimmed);
          lastSaved.current = trimmed;
          setSaveState('saved');
          // Saving a revision resolves any outstanding change request (ADR-0025).
          setRequestedChange(null);
        } catch {
          setSaveState('error');
        }
      })();
    }, 800);
    return () => window.clearTimeout(handle);
  }, [draft, detail, user, id]);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await fn();
      await loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  // One-click sign-off: persist whatever is in the editor, then lock it — so the
  // finalized record is exactly what the doctor sees, with no separate "Save
  // draft" step first. Gated behind an explicit confirmation (finalize is final).
  async function finalizeWithDraft(): Promise<void> {
    const text = draft.trim();
    // Only the assigned clinician may (re)write the draft; a sign-off doctor who did
    // not run the case finalizes the existing draft as-is (corrections become addenda),
    // so we never call draftSummary for them — that is assigned-clinician-only and 403s.
    const assignedToMe = !!user && detail?.claimedBy === user.id;
    setConfirming(false);
    setError(null);
    try {
      if (text && assignedToMe) {
        await api.draftSummary(id, text);
      }
      await api.finalizeSummary(id);
      if (assignedToMe) {
        await loadDetail();
      } else {
        // A sign-off doctor loses read access once the case is SUMMARIZED (the read
        // window is ENDED-only), so reloading the room would 403 — return to the worklist.
        navigate('/pending-signoff');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  // Return the draft to its author to revise instead of signing it (ADR-0024). The
  // case stays ENDED, so the doctor keeps read access here; the drafter is notified
  // and can re-draft, then a doctor finalizes.
  async function requestChanges(): Promise<void> {
    setError(null);
    setChangeNotice(null);
    try {
      await api.requestSummaryChanges(id, changeNote.trim() || undefined);
      setChangeNote('');
      setChangeNotice(
        'Changes requested — the drafter has been asked to revise. Sign off once they update it.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to request changes');
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
    return (
      <>
        <div className="row">
          <BackButton />
        </div>
        <p className="muted">{error ?? 'Loading…'}</p>
      </>
    );
  }

  const inSession = detail.state === 'IN_SESSION';
  const isAssignedClinician = !!user && detail.claimedBy === user.id;
  // Only the assigned clinician may write the draft (DRAFT_SUMMARY). A sign-off
  // doctor who did not run the case reviews it read-only and finalizes as-is.
  const canEditDraft =
    isAssignedClinician && (inSession || detail.state === 'ENDED') && !detail.summaryFinalized;
  // Doctor sign-off becomes available once the session has ended (ENDED → SUMMARIZED),
  // for any doctor — including one reviewing a case a nurse ran (ADR-0020).
  const canFinalize = isDoctor && detail.state === 'ENDED' && !detail.summaryFinalized;
  const reviewingForSignoff = canFinalize && !isAssignedClinician;

  return (
    <>
      <div className="row">
        <BackButton />
        <h1 style={{ marginRight: 12 }}>Consultation</h1>
        <span className={`tier-${detail.priority}`}>{detail.priority}</span>
        <span className="badge" style={{ marginLeft: 8 }}>
          {detail.state}
        </span>
        {presence.length > 0 && (
          <span className="muted" style={{ marginLeft: 12 }}>
            {presence
              .map(
                (p) =>
                  `${p.userId === detail.patientId ? 'Patient' : 'Clinician'}: ${
                    p.online ? 'online' : 'offline'
                  }`,
              )
              .join(' · ')}
          </span>
        )}
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
            {detail.summaryFinalized && (
              <Link to={`/consultations/${id}/summary`}>View finalized summary</Link>
            )}
          </div>

          {canEditDraft && requestedChange && (
            <p className="banner-attention" role="status" style={{ marginTop: 12 }}>
              <strong>A doctor asked you to revise this summary.</strong>
              {requestedChange.note ? ` “${requestedChange.note}”` : ''} Edit the draft below;
              saving your revision clears this request.
            </p>
          )}

          {canEditDraft && (
            <div style={{ marginTop: 12 }}>
              <label htmlFor="draft">Summary draft</label>
              <textarea id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="inline" style={{ marginTop: 8, alignItems: 'center' }}>
                {canFinalize && (
                  <button disabled={!draft.trim()} onClick={() => setConfirming(true)}>
                    Finalize &amp; sign off
                  </button>
                )}
                <span className="muted draft-status" aria-live="polite">
                  {saveState === 'saving' && 'Saving…'}
                  {saveState === 'saved' && 'Saved'}
                  {saveState === 'error' && "Couldn't save your last change"}
                </span>
              </div>

              {!isDoctor && detail.state === 'ENDED' && (
                <p className="muted" style={{ marginTop: 8 }}>
                  Changes are saved automatically. A doctor must sign off to finalize this summary.
                </p>
              )}
            </div>
          )}

          {reviewingForSignoff && (
            <div style={{ marginTop: 12 }}>
              <label htmlFor="draft-review">Summary draft (awaiting your sign-off)</label>
              <textarea id="draft-review" value={draft} readOnly />
              <p className="muted" style={{ marginTop: 8 }}>
                Drafted by the clinician who ran this consultation. Review it, then sign off to
                finalize — or return it for changes. After finalizing, corrections can only be added
                as addenda.
              </p>
              <label htmlFor="review-note" style={{ marginTop: 8 }}>
                Note for the drafter (optional)
              </label>
              <textarea
                id="review-note"
                className="change-note"
                rows={2}
                value={changeNote}
                maxLength={2000}
                placeholder="What should the drafter revise before this is signed?"
                onChange={(e) => setChangeNote(e.target.value)}
              />
              <div className="inline" style={{ marginTop: 8 }}>
                <button disabled={!draft.trim()} onClick={() => setConfirming(true)}>
                  Finalize &amp; sign off
                </button>
                <button className="secondary" onClick={() => void requestChanges()}>
                  Request changes
                </button>
              </div>
              {changeNotice && (
                <p className="notice" role="status" style={{ marginTop: 8 }}>
                  {changeNotice}
                </p>
              )}
            </div>
          )}

          {canFinalize && confirming && (
            <div className="confirm" role="alertdialog" aria-label="Confirm finalize">
              <p>
                Finalizing locks this summary. Afterwards, corrections can only be added as addenda
                — the summary itself can no longer be edited.
              </p>
              <div className="inline">
                <button onClick={() => void finalizeWithDraft()}>Confirm &amp; finalize</button>
                <button className="secondary" onClick={() => setConfirming(false)}>
                  Cancel
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
