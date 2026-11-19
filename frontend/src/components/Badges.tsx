import { JSX } from 'react';
import { ConsultationState, Priority } from '../lib/api';
import { priorityLabel, stateLabel } from '../lib/format';

/**
 * Small status pills used in every list and header, so a priority or a state
 * looks the same on every screen. The text always carries the meaning; colour
 * only reinforces it (WCAG 1.4.1). Colour pairs are AA-checked in contrast.test.ts.
 */
export function PriorityBadge({ priority }: { priority: Priority }): JSX.Element {
  return (
    <span className={`pill pill-priority pill-${priority.toLowerCase()}`}>
      {priorityLabel(priority)}
    </span>
  );
}

/** Tone per state: in-progress states read as info, done as success, the rest neutral. */
const STATE_TONE: Record<ConsultationState, string> = {
  REQUESTED: 'neutral',
  QUEUED: 'neutral',
  CLAIMED: 'info',
  IN_SESSION: 'info',
  ENDED: 'attention',
  SUMMARIZED: 'success',
  CANCELLED: 'muted',
};

export function StateBadge({ state }: { state: ConsultationState }): JSX.Element {
  return <span className={`pill pill-${STATE_TONE[state] ?? 'neutral'}`}>{stateLabel(state)}</span>;
}

/** A free-form status pill for derived states ("Ready to review", "Summary needed"). */
export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'info' | 'attention' | 'success' | 'muted' | 'danger';
  children: string;
}): JSX.Element {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
