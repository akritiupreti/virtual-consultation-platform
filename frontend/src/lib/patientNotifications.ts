/**
 * Maps a patient consultation's *state transition* to the message the patient
 * should be told about, and a hook that fires those messages as toasts when the
 * live-updated list changes (ADR-0021).
 *
 * Two deliberate rules keep this quiet and safe:
 *  - Only meaningful clinician-driven transitions notify (claim, start, end,
 *    finalize, and the claim-TTL re-queue). The ordinary REQUESTED→QUEUED on
 *    submit and every `position:updated` tick are intentionally silent.
 *  - Messages are **state-only** — never the chief complaint or any clinical
 *    content (invariant 6).
 */
import { useEffect, useRef } from 'react';
import { ConsultationState, MyConsultation } from './api';
import { NotificationTone, useNotify } from './notifications';

export interface PatientNotification {
  message: string;
  tone: NotificationTone;
}

/** Arrival at one of these states is worth announcing on its own. */
const ON_ENTER: Partial<Record<ConsultationState, PatientNotification>> = {
  CLAIMED: { message: 'A clinician has picked up your consultation.', tone: 'info' },
  IN_SESSION: { message: 'Your consultation has started.', tone: 'info' },
  ENDED: { message: 'Your consultation has ended.', tone: 'info' },
  SUMMARIZED: { message: 'Your consultation summary is ready to view.', tone: 'success' },
};

/**
 * Describe the notification (if any) for a single consultation moving from
 * `prev` to `next`. Returns null when the transition is a no-op or not worth
 * surfacing.
 */
export function describeTransition(
  prev: ConsultationState,
  next: ConsultationState,
): PatientNotification | null {
  if (prev === next) {
    return null;
  }
  // A claimed case falling back to the queue is the claim-start TTL expiring
  // (ADR-0010); say so, since the patient would otherwise see an unexplained
  // bounce back into the queue. A plain REQUESTED→QUEUED stays silent.
  if (prev === 'CLAIMED' && next === 'QUEUED') {
    return {
      message:
        'Your consultation returned to the queue; the next available clinician will take it.',
      tone: 'info',
    };
  }
  return ON_ENTER[next] ?? null;
}

/**
 * Watch the patient's own consultations and toast on each meaningful state
 * change. The first render only records a baseline (so existing states are not
 * re-announced on mount / login); subsequent changes notify.
 */
export function usePatientStateNotifications(consultations: MyConsultation[]): void {
  const notify = useNotify();
  const previous = useRef<Map<string, ConsultationState> | null>(null);

  useEffect(() => {
    const before = previous.current;
    if (before) {
      for (const c of consultations) {
        const prevState = before.get(c.id);
        if (prevState) {
          const note = describeTransition(prevState, c.state);
          if (note) {
            notify(note.message, { tone: note.tone });
          }
        }
      }
    }
    previous.current = new Map(consultations.map((c) => [c.id, c.state]));
  }, [consultations, notify]);
}
