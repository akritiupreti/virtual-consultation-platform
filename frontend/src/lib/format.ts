/**
 * Display formatting shared by every screen, so an enum value, a date or a wait
 * time reads the same everywhere. The API speaks in machine values
 * (`IN_SESSION`, `MENTAL_HEALTH`, ISO timestamps); people should never have to.
 */
import { ConsultationState, Priority, Role } from './api';

const STATE_LABELS: Record<ConsultationState, string> = {
  REQUESTED: 'Requested',
  QUEUED: 'In queue',
  CLAIMED: 'Claimed',
  IN_SESSION: 'In session',
  ENDED: 'Ended',
  SUMMARIZED: 'Summary finalized',
  CANCELLED: 'Cancelled',
};

export function stateLabel(state: ConsultationState): string {
  return STATE_LABELS[state] ?? humanize(state);
}

const PRIORITY_LABELS: Record<Priority, string> = {
  ROUTINE: 'Routine',
  URGENT: 'Urgent',
  EMERGENCY: 'Emergency',
};

export function priorityLabel(priority: Priority): string {
  return PRIORITY_LABELS[priority] ?? humanize(priority);
}

export const PRIORITIES: Priority[] = ['ROUTINE', 'URGENT', 'EMERGENCY'];

const ROLE_LABELS: Record<Role, string> = {
  PATIENT: 'Patient',
  NURSE: 'Nurse',
  DOCTOR: 'Doctor',
  ADMIN: 'Admin',
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? humanize(role);
}

/** Symptom categories accepted by the intake form (mirrors the backend DTO). */
export const SYMPTOM_CATEGORIES = [
  'GENERAL',
  'RESPIRATORY',
  'CARDIAC',
  'GASTROINTESTINAL',
  'MUSCULOSKELETAL',
  'DERMATOLOGY',
  'NEUROLOGICAL',
  'MENTAL_HEALTH',
  'OTHER',
] as const;

/** `MENTAL_HEALTH` → `Mental health`; the generic fallback for any enum-like value. */
export function humanize(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const words = value.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SEVERITY_LABELS = ['Very mild', 'Mild', 'Moderate', 'Severe', 'Very severe'];

/** `3` → `3/5 · Moderate`. */
export function severityLabel(severity: number): string {
  const word = SEVERITY_LABELS[severity - 1];
  return word ? `${severity}/5 · ${word}` : `${severity}/5`;
}

export function severityWord(severity: number): string {
  return SEVERITY_LABELS[severity - 1] ?? '';
}

/** Date + time in the viewer's locale, e.g. `26 Oct 2026, 14:05`; `—` when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A duration in seconds as `just now`, `12 min`, `1 h 5 min` or `2 d 3 h`. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** Time elapsed since an ISO timestamp, as `formatDuration` (e.g. "waiting 12 min"). */
export function elapsedSince(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) {
    return '—';
  }
  const then = new Date(iso).getTime();
  return Number.isNaN(then) ? '—' : formatDuration((now - then) / 1000);
}

/** `12 min ago`, or `just now` for under a minute. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  const elapsed = elapsedSince(iso, now);
  return elapsed === 'just now' || elapsed === '—' ? elapsed : `${elapsed} ago`;
}

/** First 8 characters of an opaque id — enough to tell rows apart, not to read. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}
