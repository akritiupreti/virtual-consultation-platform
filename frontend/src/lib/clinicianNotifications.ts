/**
 * Clinician-facing in-app notifications (ADR-0024), the counterpart to
 * patientNotifications. A reviewing doctor can return a drafted summary to its
 * author to revise; the server pushes `summary:changes-requested` to the author's
 * personal room, and this surfaces it as a toast wherever the clinician is.
 *
 * Unlike the patient toasts (which are deliberately state-only), this one carries
 * the doctor's optional note: it is feedback addressed to this one clinician and
 * is delivered only to their own channel — the same way a message body reaches a
 * participant. It is never persisted (invariant 6); the toast is its only surface.
 */
import { useCallback } from 'react';
import { useNotify } from './notifications';
import { SummaryChangesRequested, useSummaryChangeRequests } from './realtime';

/** The toast message for a change request, with the note when one was given. */
export function describeChangesRequested(note?: string): string {
  const trimmed = note?.trim();
  return trimmed
    ? `A doctor asked you to revise a consultation summary: “${trimmed}”`
    : 'A doctor asked you to revise a consultation summary.';
}

/** Toast when a doctor returns one of this clinician's drafts for changes. */
export function useClinicianNotifications(): void {
  const notify = useNotify();
  useSummaryChangeRequests(
    useCallback(
      (payload: SummaryChangesRequested) => {
        notify(describeChangesRequested(payload.note), { tone: 'info' });
      },
      [notify],
    ),
  );
}
