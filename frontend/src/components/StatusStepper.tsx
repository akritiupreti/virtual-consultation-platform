import { JSX } from 'react';
import { ConsultationState } from '../lib/api';

/**
 * Renders a patient consultation's progress through the state machine as a
 * horizontal stepper. This is the UI embodiment of the one invariant the whole
 * project is built on — the states, in order, that a consultation moves through
 * (CLAUDE.md invariant 1) — so the patient sees *where they are* rather than a
 * bare enum word.
 *
 * `CANCELLED` is off the happy path (it has no place on the line), so it renders
 * a distinct terminal notice instead of the stepper.
 *
 * Accessibility: an ordered list labelled "Consultation progress"; the active
 * step carries `aria-current="step"`, and each step's done/upcoming status is
 * given to assistive tech as visually-hidden text (the tick glyph is decorative
 * and `aria-hidden`), so meaning never rests on colour or the icon alone.
 */
interface Step {
  state: ConsultationState;
  label: string;
}

const STEPS: readonly Step[] = [
  { state: 'REQUESTED', label: 'Requested' },
  { state: 'QUEUED', label: 'Queued' },
  { state: 'CLAIMED', label: 'With clinician' },
  { state: 'IN_SESSION', label: 'In session' },
  { state: 'ENDED', label: 'Ended' },
  { state: 'SUMMARIZED', label: 'Summary ready' },
];

export default function StatusStepper({ state }: { state: ConsultationState }): JSX.Element {
  if (state === 'CANCELLED') {
    return (
      <p className="stepper-cancelled">
        <span className="stepper-cancelled-mark" aria-hidden="true">
          ✕
        </span>
        Consultation cancelled
      </p>
    );
  }

  const currentIndex = STEPS.findIndex((s) => s.state === state);

  return (
    <ol className="stepper" aria-label="Consultation progress">
      {STEPS.map((step, i) => {
        const status = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
        return (
          <li
            key={step.state}
            className={`stepper-step is-${status}`}
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <span className="stepper-dot" aria-hidden="true">
              {status === 'done' ? '✓' : ''}
            </span>
            <span className="stepper-label">{step.label}</span>
            {status === 'done' && <span className="sr-only"> (completed)</span>}
            {status === 'todo' && <span className="sr-only"> (not started)</span>}
          </li>
        );
      })}
    </ol>
  );
}
