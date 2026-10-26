import { JSX, useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { MyConsultation } from './api';
import { describeTransition, usePatientStateNotifications } from './patientNotifications';
import { renderWithProviders } from '../test/render';

function base(state: MyConsultation['state']): MyConsultation {
  return {
    id: 'c-1',
    state,
    priority: 'ROUTINE',
    createdAt: '2026-10-22T09:00:00.000Z',
    complaintSummary: 'Sample complaint (synthetic)',
    position: 0,
    summaryAvailable: state === 'SUMMARIZED',
  };
}

describe('describeTransition', () => {
  it('announces the clinician-driven transitions', () => {
    expect(describeTransition('QUEUED', 'CLAIMED')?.message).toMatch(/picked up/i);
    expect(describeTransition('CLAIMED', 'IN_SESSION')?.message).toMatch(/started/i);
    expect(describeTransition('IN_SESSION', 'ENDED')?.message).toMatch(/ended/i);
    const finalized = describeTransition('ENDED', 'SUMMARIZED');
    expect(finalized?.message).toMatch(/summary is ready/i);
    expect(finalized?.tone).toBe('success');
  });

  it('explains a claim-TTL re-queue but stays silent on the ordinary enqueue', () => {
    expect(describeTransition('CLAIMED', 'QUEUED')?.message).toMatch(/returned to the queue/i);
    // Submitting a request (REQUESTED → QUEUED) must not notify.
    expect(describeTransition('REQUESTED', 'QUEUED')).toBeNull();
  });

  it('returns null for a no-op or non-noteworthy transition', () => {
    expect(describeTransition('QUEUED', 'QUEUED')).toBeNull();
    expect(describeTransition('REQUESTED', 'CANCELLED')).toBeNull();
  });

  it('carries no clinical content — messages are state-only', () => {
    const messages = (['CLAIMED', 'IN_SESSION', 'ENDED', 'SUMMARIZED'] as const)
      .map((s) => describeTransition('QUEUED', s)?.message ?? '')
      .join(' ');
    expect(messages).not.toMatch(/complaint|symptom|diagnos/i);
  });
});

/** Drives a state change through a click so the effect sees prev → next. */
function Harness({
  from,
  to,
}: {
  from: MyConsultation['state'];
  to: MyConsultation['state'];
}): JSX.Element {
  const [list, setList] = useState<MyConsultation[]>([base(from)]);
  usePatientStateNotifications(list);
  return (
    <button type="button" onClick={() => setList([base(to)])}>
      advance
    </button>
  );
}

describe('usePatientStateNotifications', () => {
  it('records a baseline on mount and does not announce existing state', () => {
    const { queryByRole } = renderWithProviders(<Harness from="CLAIMED" to="IN_SESSION" />);
    // Nothing fired yet — the first render is only the baseline.
    expect(queryByRole('status')?.textContent ?? '').not.toMatch(/started/i);
  });

  it('toasts when the observed state transitions', async () => {
    const { user, getByRole, findByText } = renderWithProviders(
      <Harness from="QUEUED" to="CLAIMED" />,
    );
    await user.click(getByRole('button', { name: /advance/i }));
    expect(await findByText(/picked up your consultation/i)).toBeInTheDocument();
  });
});
