import { FormEvent, JSX, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PriorityBadge } from '../components/Badges';
import ConfirmPanel from '../components/ConfirmPanel';
import StatusStepper from '../components/StatusStepper';
import { ApiError, api, MyConsultation, Priority } from '../lib/api';
import {
  formatDateTime,
  humanize,
  PRIORITIES,
  priorityLabel,
  severityWord,
  SYMPTOM_CATEGORIES,
} from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { usePatientStateNotifications } from '../lib/patientNotifications';
import { usePatientUpdates } from '../lib/realtime';

const OPEN_ROOM_STATES = new Set(['CLAIMED', 'IN_SESSION', 'ENDED', 'SUMMARIZED']);
const CANCELLABLE = new Set(['REQUESTED', 'QUEUED', 'CLAIMED']);
const FINISHED = new Set(['SUMMARIZED', 'CANCELLED']);

/** "N ahead of you", phrased for a person rather than a counter. */
function positionText(position: number): string {
  if (position === 0) {
    return 'You are next in the queue';
  }
  return `${position} ${position === 1 ? 'person' : 'people'} ahead of you`;
}

function ConsultationItem({
  c,
  confirmingCancel,
  onAskCancel,
  onCancel,
  onKeep,
  busy,
}: {
  c: MyConsultation;
  confirmingCancel: boolean;
  onAskCancel: () => void;
  onCancel: () => void;
  onKeep: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <li className="consult-item">
      <div className="consult-head">
        <div className="consult-title">
          <span className="cell-primary">{c.complaintSummary || 'Consultation'}</span>
          <span className="muted">Requested {formatDateTime(c.createdAt)}</span>
        </div>
        <PriorityBadge priority={c.priority} />
      </div>
      <StatusStepper state={c.state} />
      {c.state === 'QUEUED' && c.position !== null && (
        <p className="queue-position">{positionText(c.position)}</p>
      )}
      <div className="actions consult-actions">
        {OPEN_ROOM_STATES.has(c.state) && (
          <Link className="btn-link btn-sm" to={`/consultations/${c.id}`}>
            Open room
          </Link>
        )}
        {c.summaryAvailable && (
          <Link className="btn-link btn-outline btn-sm" to={`/consultations/${c.id}/summary`}>
            View summary
          </Link>
        )}
        {CANCELLABLE.has(c.state) && !confirmingCancel && (
          <button className="link-btn danger-text" onClick={onAskCancel}>
            Cancel request
          </button>
        )}
      </div>
      {confirmingCancel && (
        <ConfirmPanel
          label="Confirm cancel request"
          confirmLabel="Cancel request"
          danger
          busy={busy}
          onConfirm={onCancel}
          onCancel={onKeep}
        >
          <p>Cancel this consultation request? You would need to submit a new one.</p>
        </ConfirmPanel>
      )}
    </li>
  );
}

export default function PatientHome(): JSX.Element {
  useDocumentTitle('My consultations');
  const [mine, setMine] = useState<MyConsultation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [symptomCategory, setSymptomCategory] = useState<string>(SYMPTOM_CATEGORIES[0]);
  const [onsetDuration, setOnsetDuration] = useState('');
  const [severity, setSeverity] = useState(3);
  const [priority, setPriority] = useState<Priority>('ROUTINE');
  const [history, setHistory] = useState('');
  const [medications, setMedications] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMine(await api.getMine());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load your consultations');
    }
  }, []);

  // Live position / state pushes (ADR-0004); slow interval is a fallback only.
  usePatientUpdates(refresh);
  // Surface meaningful state changes (claim/start/end/finalize) as toasts.
  usePatientStateNotifications(mine ?? []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api.submitRequest({
        chiefComplaint: chiefComplaint.trim(),
        symptomCategory,
        onsetDuration: onsetDuration.trim(),
        severity,
        consent,
        priority,
        history: history.trim() || undefined,
        medications: medications.trim() || undefined,
      });
      setChiefComplaint('');
      setSymptomCategory(SYMPTOM_CATEGORIES[0]);
      setOnsetDuration('');
      setSeverity(3);
      setPriority('ROUTINE');
      setHistory('');
      setMedications('');
      setConsent(false);
      setNotice('Request submitted. You are in the queue — this page updates as it progresses.');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit request');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    setError(null);
    setCancelling(true);
    try {
      await api.cancel(id);
      setCancelId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  }

  const list = mine ?? [];
  const current = list.filter((c) => !FINISHED.has(c.state));
  const past = list.filter((c) => FINISHED.has(c.state));

  const renderItem = (c: MyConsultation): JSX.Element => (
    <ConsultationItem
      key={c.id}
      c={c}
      confirmingCancel={cancelId === c.id}
      onAskCancel={() => setCancelId(c.id)}
      onCancel={() => void cancel(c.id)}
      onKeep={() => setCancelId(null)}
      busy={cancelling}
    />
  );

  const requestForm = (
    <section className="card" aria-labelledby="request-heading">
      <h2 id="request-heading">Request a consultation</h2>
      <form onSubmit={submit}>
        <label htmlFor="cc">What is the main problem?</label>
        <textarea
          id="cc"
          rows={3}
          value={chiefComplaint}
          onChange={(e) => setChiefComplaint(e.target.value)}
          required
          minLength={3}
          maxLength={2000}
          aria-describedby="cc-hint"
        />
        <p className="hint" id="cc-hint">
          Describe your symptoms in a sentence or two (chief complaint).
        </p>

        <div className="field-row">
          <div>
            <label htmlFor="cat">Symptom category</label>
            <select
              id="cat"
              value={symptomCategory}
              onChange={(e) => setSymptomCategory(e.target.value)}
            >
              {SYMPTOM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="onset">Onset / duration</label>
            <input
              id="onset"
              value={onsetDuration}
              onChange={(e) => setOnsetDuration(e.target.value)}
              required
              maxLength={100}
              placeholder="e.g. 2 days"
            />
          </div>
        </div>

        <div className="field-row">
          <div>
            <label htmlFor="sev">Severity</label>
            <select id="sev" value={severity} onChange={(e) => setSeverity(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} — {severityWord(n)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="prio">Suggested priority</label>
            <select
              id="prio"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              aria-describedby="prio-hint"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {priorityLabel(p)}
                </option>
              ))}
            </select>
            <p className="hint" id="prio-hint">
              A clinician reviews and may change it.
            </p>
          </div>
        </div>

        <label htmlFor="history">
          Relevant medical history <span className="optional">(optional)</span>
        </label>
        <textarea
          id="history"
          rows={2}
          value={history}
          maxLength={2000}
          onChange={(e) => setHistory(e.target.value)}
        />

        <label htmlFor="meds">
          Current medications <span className="optional">(optional)</span>
        </label>
        <textarea
          id="meds"
          rows={2}
          value={medications}
          maxLength={2000}
          onChange={(e) => setMedications(e.target.value)}
        />

        <label className="checkbox">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I consent to the processing of my clinical data for this consultation.</span>
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || !consent}>
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </section>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>My consultations</h1>
          <p className="muted">
            Request a consultation and follow it from the queue to your summary.
          </p>
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

      {current.length > 0 && (
        <section className="card" aria-labelledby="current-heading">
          <h2 id="current-heading">Current</h2>
          <ul className="consult-list">{current.map(renderItem)}</ul>
        </section>
      )}

      {requestForm}

      <section className="card" aria-labelledby="past-heading">
        <h2 id="past-heading">Past consultations</h2>
        {mine === null && !error ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : past.length === 0 ? (
          <p className="muted empty">
            {list.length === 0
              ? 'No consultations yet. Submit a request above to get started.'
              : 'Finished and cancelled consultations will appear here.'}
          </p>
        ) : (
          <ul className="consult-list">{past.map(renderItem)}</ul>
        )}
      </section>
    </>
  );
}
