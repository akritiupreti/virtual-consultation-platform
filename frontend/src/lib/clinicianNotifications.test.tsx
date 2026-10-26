import { JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render';
import { describeChangesRequested, useClinicianNotifications } from './clinicianNotifications';
import type { SummaryChangesRequested } from './realtime';

// Capture the callback the hook registers so a test can drive the socket event.
const bus = vi.hoisted(() => ({
  fire: undefined as undefined | ((p: SummaryChangesRequested) => void),
}));
vi.mock('./realtime', () => ({
  useSummaryChangeRequests: (cb: (p: SummaryChangesRequested) => void) => {
    bus.fire = cb;
  },
}));

describe('describeChangesRequested', () => {
  it('includes the note when one was given', () => {
    const msg = describeChangesRequested('Add the BP reading');
    expect(msg).toMatch(/revise a consultation summary/i);
    expect(msg).toContain('Add the BP reading');
  });

  it('falls back to a plain message with no note (blank is treated as none)', () => {
    expect(describeChangesRequested()).toBe('A doctor asked you to revise a consultation summary.');
    expect(describeChangesRequested('   ')).not.toContain('“');
  });
});

function Harness(): JSX.Element {
  useClinicianNotifications();
  return (
    <button
      type="button"
      onClick={() => bus.fire?.({ consultationId: 'c-1', note: 'Please add the BP reading.' })}
    >
      fire
    </button>
  );
}

describe('useClinicianNotifications', () => {
  it('toasts the drafter when a doctor requests changes', async () => {
    const { user, getByRole, findByText } = renderWithProviders(<Harness />);
    await user.click(getByRole('button', { name: /fire/i }));
    expect(await findByText(/please add the bp reading/i)).toBeInTheDocument();
  });
});
