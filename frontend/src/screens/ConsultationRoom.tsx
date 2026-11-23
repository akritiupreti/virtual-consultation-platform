import { FormEvent, JSX, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import BackButton from '../components/BackButton';
import { PriorityBadge, StateBadge } from '../components/Badges';
import ConfirmPanel from '../components/ConfirmPanel';
import StatusStepper from '../components/StatusStepper';
import { ApiError, api, ConsultationDetail, ConsultationState, Message } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useNotify } from '../lib/notifications';
import { formatDateTime, formatTime, humanize, severityLabel } from '../lib/format';
import { useDocumentTitle, useUnsavedChangesWarning } from '../lib/hooks';
import { useConsultationRoom, useSummaryUpdates } from '../lib/realtime';

/** What the patient should know at each point of the consultation. */
const PATIENT_GUIDANCE: Partial<Record<ConsultationState, string>> = {
  CLAIMED:
    'A clinician has picked up your consultation and will start the session shortly. Messaging opens when the session starts.',
  ENDED:
    'The session has ended. Your summary will appear here once a doctor has reviewed and signed it.',
  CANCELLED: 'This consultation was cancelled.',
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function ConsultationRoom(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const notify = useNotify();
  useDocumentTitle('Consultation');

  const [detail, setDetail] = useState<ConsultationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when this viewer loses access mid-review (e.g. another doctor signed the
  // case off, so it left the sign-off window this doctor could read).
  const [gone, setGone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'finalize' | 'end' | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Summary draft ─────────────────────────────────────────────────────────
  // The editor text, and the last version the server holds. The difference is
  // "unsaved changes": saving is an explicit action, so a half-written
  // revision never reaches a reviewing doctor.
  const [draft, setDraft] = useState('');
  const [savedDraft, setSavedDraft] = useState('');
  const [hasSummary, setHasSummary] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Reviewer side: tells a reviewing doctor the draft changed under them.
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);

  const messageList = useRef<HTMLDivElement>(null);

  const isClinician = user?.role === 'NURSE' || user?.role === 'DOCTOR';
  const isDoctor = user?.role === 'DOCTOR';
  const isParticipant =
    !!user && !!detail && (detail.patientId === user.id || detail.claimedBy === user.id);
  const isAssignedClinician = !!user && !!detail && detail.claimedBy === user.id;
  const canEditDraft =
    isAssignedClinician &&
    !!detail &&
    (detail.state === 'IN_SESSION' || detail.state === 'ENDED') &&
    !detail.summaryFinalized;
  const dirty = canEditDraft && draft.trim() !== savedDraft.trim();
  useUnsavedChangesWarning(dirty);

  // Mirror the editor into refs so a live reload never clobbers what is being typed.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await api.getConsultation(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setGone(
          'This consultation is no longer available to you — it may have been signed off by another doctor.',
        );
        return;
      }
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

  /**
   * Read the summary from the server. For the drafter, never replace text they
   * are still editing; for a reviewing doctor, always show the latest version and
   * say so when it changed under them (`live`).
   */
  const loadSummary = useCallback(
    async (live = false) => {
      try {
        const s = await api.getSummary(id);
        setHasSummary(true);
        setSavedDraft(s.content);
        if (!dirtyRef.current) {
          const current = draftRef.current.trim();
          if (live && current && current !== s.content.trim()) {
            setReviewNotice('The drafter saved a revision — the latest version is shown below.');
          }
          setDraft(s.content);
        }
      } catch {
        /* no draft yet, or not this viewer's to read */
      }
    },
    [id],
  );

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // Messages are the two participants' only (matrix). A doctor
  // reviewing a case for sign-off sees the intake and the draft, not the chat.
  useEffect(() => {
    if (!isParticipant) {
      return;
    }
    void loadMessages();
    // Slow fallback only; the socket delivers new messages immediately.
    const timer = setInterval(() => void loadMessages(), 15000);
    return () => clearInterval(timer);
  }, [isParticipant, loadMessages]);

  useEffect(() => {
    if (isClinician) {
      void loadSummary();
    }
  }, [isClinician, loadSummary]);

  // Live room: new messages and state changes (ADR-0004).
  useConsultationRoom(id, {
    onMessage: (m) =>
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m])),
    onConsultationUpdated: () => void loadDetail(),
  });

  // Live summary signals (ADR-0004): a reviewing doctor sees a revision arrive,
  // and the case leaves their view once signed off, without reloading the page.
  useSummaryUpdates((payload) => {
    if (payload.consultationId !== id || !isClinician) {
      return;
    }
    void loadSummary(true);
    if (payload.reason === 'finalized') {
      void loadDetail();
    }
  });

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const list = messageList.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages.length]);

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Persist the editor content. */
  async function saveDraft(): Promise<boolean> {
    const content = draft.trim();
    if (!content) {
      return false;
    }
    setSaveState('saving');
    try {
      const saved = await api.draftSummary(id, content);
      setSavedDraft(saved.content);
      setHasSummary(true);
      setSaveState('saved');
      setSavedAt(new Date().toISOString());
      return true;
    } catch (err) {
      setSaveState('error');
      setError(err instanceof ApiError ? err.message : 'Could not save the summary draft');
      return false;
    }
  }

  async function endSession(): Promise<void> {
    setConfirming(null);
    // Never lose the summary written so far: save it before the session closes.
    if (dirty && draft.trim() && !(await saveDraft())) {
      return;
    }
    if (await run(() => api.complete(id))) {
      await loadDetail();
    }
  }

  // Finalize locks the summary. The assigned doctor's current text is saved first,
  // so the signed record is exactly what they see; a sign-off doctor who did not
  // run the case finalizes the saved draft as-is (they may not re-draft — ADR-0009).
  async function finalize(): Promise<void> {
    setConfirming(null);
    if (isAssignedClinician && dirty && !(await saveDraft())) {
      return;
    }
    const ok = await run(() => api.finalizeSummary(id));
    if (!ok) {
      return;
    }
    if (isAssignedClinician) {
      await loadDetail();
    } else {
      // A sign-off doctor's read access ends with the sign-off window (ADR-0009
      // keeps the summary itself readable), so go back to the worklist.
      notify('Summary finalized and shared with the patient.', { tone: 'success' });
      navigate('/pending-signoff', { replace: true });
    }
  }

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending) {
      return;
    }
    setError(null);
    setSending(true);
    try {
      const sent = await api.sendMessage(id, body);
      setText('');
      setMessages((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, sent]));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  function senderLabel(senderId: string): string {
    if (senderId === user?.id) {
      return 'You';
    }
    return senderId === detail?.patientId ? 'Patient' : 'Clinician';
  }

  if (gone) {
    return (
      <>
        <BackButton />
        <p className="banner banner-info" role="status">
          {gone}
        </p>
        {isDoctor && <Link to="/pending-signoff">Go to pending sign-off</Link>}
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <BackButton />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted" aria-live="polite">
            Loading consultation…
          </p>
        )}
      </>
    );
  }

  const inSession = detail.state === 'IN_SESSION';
  // Doctor sign-off becomes available once the session has ended (ENDED → SUMMARIZED),
  // for any doctor — including one reviewing a case a nurse ran (ADR-0009).
  const canFinalize = isDoctor && detail.state === 'ENDED' && !detail.summaryFinalized;
  const reviewingForSignoff = canFinalize && !isAssignedClinician;
  const patientGuidance = user?.role === 'PATIENT' ? PATIENT_GUIDANCE[detail.state] : undefined;

  return (
    <>
      <BackButton
        confirmLeave={
          dirty ? 'You have unsaved changes to the summary. Leave without saving?' : undefined
        }
      />
      <div className="page-header">
        <div>
          <h1>Consultation</h1>
          <div className="meta-row">
            <PriorityBadge priority={detail.priority} />
            <StateBadge state={detail.state} />
            <span className="muted">Requested {formatDateTime(detail.createdAt)}</span>
          </div>
        </div>
        {isAssignedClinician && (
          <div className="actions">
            {detail.state === 'CLAIMED' && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => api.start(id)).then(async (ok) => {
                    if (ok) {
                      await loadDetail();
                    }
                  })
                }
              >
                Start session
              </button>
            )}
            {inSession && (
              <button
                className="secondary"
                disabled={busy || confirming === 'end'}
                onClick={() => setConfirming('end')}
              >
                End consultation
              </button>
            )}
          </div>
        )}
      </div>

      <StatusStepper state={detail.state} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {patientGuidance && <p className="banner banner-info">{patientGuidance}</p>}
      {isAssignedClinician && detail.state === 'CLAIMED' && (
        <p className="banner banner-info">
          Start the session when you are ready. A claim that is not started within a few minutes
          returns to the queue automatically.
        </p>
      )}
      {detail.summaryFinalized && (
        <p className="notice">
          The summary for this consultation has been finalized.{' '}
          <Link to={`/consultations/${id}/summary`}>View the summary</Link>
        </p>
      )}

      {confirming === 'end' && (
        <ConfirmPanel
          label="Confirm end consultation"
          confirmLabel="End consultation"
          busy={busy}
          onConfirm={() => void endSession()}
          onCancel={() => setConfirming(null)}
        >
          <p>
            Ending closes messaging for both of you.
            {dirty && ' Your unsaved summary draft will be saved first.'}
            {!isDoctor && ' A doctor signs off the summary afterwards.'}
          </p>
        </ConfirmPanel>
      )}

      <div className={`room-grid${isParticipant ? '' : ' room-grid-single'}`}>
        {isParticipant && (
          <div className="room-main">
            <section className="card" aria-labelledby="messages-heading">
              <h2 id="messages-heading">Messages</h2>
              <div
                className="messages"
                ref={messageList}
                role="log"
                aria-live="polite"
                aria-label="Conversation"
              >
                {messages.length === 0 && (
                  <p className="muted empty">
                    {inSession
                      ? 'No messages yet. Say hello.'
                      : 'No messages in this consultation.'}
                  </p>
                )}
                {messages.map((m) => {
                  const mine = m.senderId === user?.id;
                  return (
                    <div key={m.id} className={`msg${mine ? ' mine' : ''}`}>
                      <div className="msg-meta">
                        <span className="msg-sender">{senderLabel(m.senderId)}</span>
                        <time dateTime={m.createdAt} title={formatDateTime(m.createdAt)}>
                          {formatTime(m.createdAt)}
                        </time>
                      </div>
                      <div className="msg-body">{m.body}</div>
                    </div>
                  );
                })}
              </div>
              <form onSubmit={send} className="composer">
                <label htmlFor="message" className="sr-only">
                  Message
                </label>
                <input
                  id="message"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    inSession ? 'Type a message…' : 'Messaging is open during the session only'
                  }
                  disabled={!inSession}
                  maxLength={4000}
                  autoComplete="off"
                />
                <button type="submit" disabled={!inSession || !text.trim() || sending}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
            </section>
          </div>
        )}

        <div className="room-side">
          {detail.intake && (
            <section className="card" aria-labelledby="intake-heading">
              <h2 id="intake-heading">Intake</h2>
              <p className="intake-complaint">{detail.intake.chiefComplaint}</p>
              <dl className="dl">
                <dt>Category</dt>
                <dd>{humanize(detail.intake.symptomCategory)}</dd>
                <dt>Onset</dt>
                <dd>{detail.intake.onsetDuration}</dd>
                <dt>Severity</dt>
                <dd>{severityLabel(detail.intake.severity)}</dd>
                <dt>History</dt>
                <dd>{detail.intake.history || 'None given'}</dd>
                <dt>Medications</dt>
                <dd>{detail.intake.medications || 'None given'}</dd>
              </dl>
            </section>
          )}

          {canEditDraft && (
            <section className="card" aria-labelledby="summary-heading">
              <h2 id="summary-heading">Clinical summary</h2>
              {!isDoctor && detail.state === 'ENDED' && !hasSummary && (
                <p className="banner banner-attention" role="status">
                  Write and save the summary — a doctor can only sign off once a draft is saved.
                </p>
              )}
              <label htmlFor="draft">Summary draft</label>
              <textarea
                id="draft"
                className="draft-editor"
                value={draft}
                rows={8}
                maxLength={8000}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (saveState !== 'saving') {
                    setSaveState('idle');
                  }
                }}
                aria-describedby="draft-status"
              />
              <div className="actions editor-actions">
                <button
                  type="button"
                  className={canFinalize ? 'secondary' : undefined}
                  disabled={!dirty || !draft.trim() || saveState === 'saving'}
                  onClick={() => void saveDraft()}
                >
                  {saveState === 'saving' ? 'Saving…' : 'Save draft'}
                </button>
                {canFinalize && (
                  <button
                    type="button"
                    disabled={!draft.trim() || busy}
                    onClick={() => setConfirming('finalize')}
                  >
                    Finalize &amp; sign off
                  </button>
                )}
                <span id="draft-status" className="muted draft-status" aria-live="polite">
                  {dirty
                    ? 'Unsaved changes'
                    : saveState === 'error'
                      ? 'Not saved'
                      : savedAt
                        ? `Saved at ${formatTime(savedAt)}`
                        : hasSummary
                          ? 'All changes saved'
                          : ''}
                </span>
              </div>
              {!isDoctor && (
                <p className="hint">
                  {detail.state === 'ENDED'
                    ? 'Saved drafts appear on the doctors’ sign-off list. A doctor finalizes the summary.'
                    : 'Draft as you go and save before ending. Doctors see it for sign-off once the session ends.'}
                </p>
              )}
            </section>
          )}

          {reviewingForSignoff && (
            <section className="card" aria-labelledby="review-heading">
              <h2 id="review-heading">Summary awaiting your sign-off</h2>
              {reviewNotice && (
                <p className="notice" role="status">
                  {reviewNotice}
                </p>
              )}
              {hasSummary ? (
                <pre className="summary-text">{draft}</pre>
              ) : (
                <p className="muted">No draft has been saved for this consultation yet.</p>
              )}
              <p className="hint">
                Drafted by the clinician who ran this consultation. Signing off finalizes it; a
                signed summary cannot be changed.
              </p>
              <div className="actions editor-actions">
                <button
                  type="button"
                  disabled={!hasSummary || busy}
                  onClick={() => setConfirming('finalize')}
                >
                  Finalize &amp; sign off
                </button>
              </div>
            </section>
          )}

          {canFinalize && confirming === 'finalize' && (
            <ConfirmPanel
              label="Confirm finalize"
              confirmLabel="Confirm & finalize"
              busy={busy}
              onConfirm={() => void finalize()}
              onCancel={() => setConfirming(null)}
            >
              <p>
                Finalizing locks this summary and shares it with the patient. It cannot be changed
                afterwards.
                {isAssignedClinician && dirty && ' Your unsaved changes will be saved first.'}
              </p>
            </ConfirmPanel>
          )}

          {!isParticipant && !reviewingForSignoff && (
            <p className="muted">Messages are visible to the consultation’s participants.</p>
          )}
        </div>
      </div>
    </>
  );
}
