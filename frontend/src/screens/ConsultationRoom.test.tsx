import { act, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../lib/api';
import type { SummaryUpdated } from '../lib/realtime';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import ConsultationRoom from './ConsultationRoom';

const mock = vi.hoisted(() => ({
  getConsultation: vi.fn(),
  getMessages: vi.fn(),
  getSummary: vi.fn(),
  sendMessage: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  finalizeSummary: vi.fn(),
  draftSummary: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});

// Capture the live summary handler so a test can play a server signal (ADR-0022).
const live = vi.hoisted(() => ({ summary: null as null | ((p: SummaryUpdated) => void) }));
vi.mock('../lib/realtime', () => ({
  useConsultationRoom: () => undefined,
  useSummaryUpdates: (cb: (p: SummaryUpdated) => void) => {
    live.summary = cb;
  },
}));

function render(user: AuthUser) {
  return renderWithProviders(<ConsultationRoom />, {
    user,
    route: '/consultations/c-1',
    path: '/consultations/:id',
  });
}

const nurseRunEnded = () => fixtures.consultation({ state: 'ENDED', claimedBy: 'u-nurse' });

describe('ConsultationRoom screen', () => {
  beforeEach(() => {
    live.summary = null;
    mock.getConsultation.mockReset().mockResolvedValue(fixtures.consultation());
    mock.getMessages.mockReset().mockResolvedValue(fixtures.messages);
    mock.getSummary.mockReset().mockResolvedValue(fixtures.summary({ finalized: false }));
    mock.sendMessage.mockReset().mockResolvedValue(fixtures.messages[1]);
    mock.start.mockReset().mockResolvedValue(fixtures.consultation());
    mock.complete.mockReset().mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    mock.finalizeSummary.mockReset();
    mock.draftSummary.mockReset();
  });

  it('renders intake, state and messages with sender labels', async () => {
    const { findByText, getByText, getAllByText } = render(fixtures.users.doctor);
    expect(await findByText(/synthetic chief complaint/i)).toBeInTheDocument();
    expect(await findByText(/sample patient message/i)).toBeInTheDocument();
    // Human-readable state, not the enum.
    expect(getAllByText('In session').length).toBeGreaterThan(0);
    expect(getByText('Patient')).toBeInTheDocument();
    expect(getByText('You')).toBeInTheDocument();
  });

  it('lets a clinician send a message during the session', async () => {
    const { user, findByPlaceholderText, getByRole } = render(fixtures.users.doctor);
    const input = await findByPlaceholderText(/type a message/i);
    await user.type(input, 'Hello there');
    await user.click(getByRole('button', { name: /send/i }));
    expect(mock.sendMessage).toHaveBeenCalledWith('c-1', 'Hello there');
  });

  it('offers Start session to the assigned clinician when the case is CLAIMED', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'CLAIMED' }));
    const { user, findByRole } = render(fixtures.users.doctor);
    await user.click(await findByRole('button', { name: /start session/i }));
    expect(mock.start).toHaveBeenCalledWith('c-1');
  });

  it('saves the summary draft only when the clinician clicks Save (ADR-0021)', async () => {
    const { user, findByLabelText, getByRole, findByText } = render(fixtures.users.doctor);
    const draft = await findByLabelText(/summary draft/i);
    await waitFor(() => expect(draft).toHaveValue('Synthetic summary content for testing only.'));
    mock.draftSummary.mockResolvedValue(
      fixtures.summary({
        finalized: false,
        content: 'Synthetic summary content for testing only. More',
      }),
    );

    await user.type(draft, ' More');
    // Typing alone never persists — the edit is marked unsaved.
    expect(await findByText(/unsaved changes/i)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 900));
    expect(mock.draftSummary).not.toHaveBeenCalled();

    await user.click(getByRole('button', { name: /save draft/i }));
    expect(mock.draftSummary).toHaveBeenCalledWith(
      'c-1',
      'Synthetic summary content for testing only. More',
    );
    expect(await findByText(/saved at/i)).toBeInTheDocument();
  });

  it('keeps Save disabled until there is an unsaved change', async () => {
    const { findByRole } = render(fixtures.users.doctor);
    expect(await findByRole('button', { name: /save draft/i })).toBeDisabled();
  });

  it('asks before ending the session and saves an unsaved draft first', async () => {
    mock.getSummary.mockRejectedValue(new Error('no draft'));
    mock.draftSummary.mockResolvedValue(fixtures.summary({ finalized: false, content: 'Notes' }));
    const { user, findByLabelText, getByRole, findByRole } = render(fixtures.users.doctor);
    await user.type(await findByLabelText(/summary draft/i), 'Notes');

    await user.click(getByRole('button', { name: /end consultation/i }));
    // Nothing happens until it is confirmed.
    expect(mock.complete).not.toHaveBeenCalled();
    const dialog = await findByRole('alertdialog', { name: /confirm end consultation/i });
    expect(dialog).toHaveTextContent(/unsaved summary draft will be saved first/i);

    await user.click(within(dialog).getByRole('button', { name: /^end consultation$/i }));
    await waitFor(() => expect(mock.complete).toHaveBeenCalledWith('c-1'));
    expect(mock.draftSummary).toHaveBeenCalledWith('c-1', 'Notes');
    expect(mock.draftSummary.mock.invocationCallOrder[0]).toBeLessThan(
      mock.complete.mock.invocationCallOrder[0],
    );
  });

  it('offers Finalize & sign off only to a doctor on an ENDED case', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    const { findByRole } = render(fixtures.users.doctor);
    expect(await findByRole('button', { name: /finalize & sign off/i })).toBeInTheDocument();
  });

  it('does not offer Finalize & sign off to the assigned nurse on an ENDED case', async () => {
    mock.getConsultation.mockResolvedValue(nurseRunEnded());
    const { findByText, queryByRole } = render(fixtures.users.nurse);
    await findByText(/a doctor finalizes the summary/i);
    expect(queryByRole('button', { name: /finalize & sign off/i })).not.toBeInTheDocument();
  });

  it('tells the nurse a saved draft is required when an ended case has none', async () => {
    mock.getConsultation.mockResolvedValue(nurseRunEnded());
    mock.getSummary.mockRejectedValue(new Error('404'));
    const { findByText } = render(fixtures.users.nurse);
    expect(
      await findByText(/a doctor can only sign off once a draft is saved/i),
    ).toBeInTheDocument();
  });

  it('lets a non-assigned doctor review read-only and sign off a nurse-run case without re-drafting', async () => {
    mock.getConsultation.mockResolvedValue(nurseRunEnded());
    mock.getSummary.mockResolvedValue(
      fixtures.summary({ finalized: false, content: 'Nurse-authored draft' }),
    );
    mock.finalizeSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { user, findByText, findByRole, getByRole, queryByRole } = render(fixtures.users.doctor);

    // The draft is shown read-only — there is no editable "Summary draft" field.
    expect(await findByText('Nurse-authored draft')).toBeInTheDocument();
    expect(queryByRole('textbox', { name: /^summary draft$/i })).not.toBeInTheDocument();
    // A reviewer is not a participant: the conversation is not loaded.
    expect(mock.getMessages).not.toHaveBeenCalled();

    const signOff = await findByRole('button', { name: /finalize & sign off/i });
    await waitFor(() => expect(signOff).toBeEnabled());
    await user.click(signOff);
    await user.click(getByRole('button', { name: /confirm & finalize/i }));

    // Finalizes the existing draft as-is — never re-drafts (that would 403).
    expect(mock.draftSummary).not.toHaveBeenCalled();
    expect(mock.finalizeSummary).toHaveBeenCalledWith('c-1');
  });

  it('shows the reviewing doctor a revision the drafter saves, live (ADR-0022)', async () => {
    mock.getConsultation.mockResolvedValue(nurseRunEnded());
    mock.getSummary.mockResolvedValue(
      fixtures.summary({ finalized: false, content: 'First draft' }),
    );
    const { findByText } = render(fixtures.users.doctor);
    await findByText('First draft');

    mock.getSummary.mockResolvedValue(
      fixtures.summary({ finalized: false, content: 'Revised draft with BP' }),
    );
    await act(async () => live.summary?.({ consultationId: 'c-1', reason: 'drafted' }));

    expect(await findByText('Revised draft with BP')).toBeInTheDocument();
    expect(await findByText(/the drafter saved a revision/i)).toBeInTheDocument();
  });

  it('never overwrites text the drafter is still editing when a signal arrives', async () => {
    mock.getConsultation.mockResolvedValue(nurseRunEnded());
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false, content: 'Saved' }));
    const { user, findByLabelText } = render(fixtures.users.nurse);
    const draft = await findByLabelText(/summary draft/i);
    await waitFor(() => expect(draft).toHaveValue('Saved'));
    await user.type(draft, ' and typing');

    await act(async () => live.summary?.({ consultationId: 'c-1', reason: 'drafted' }));
    expect(draft).toHaveValue('Saved and typing');
  });

  it('ignores summary signals for other consultations', async () => {
    const { findByText } = render(fixtures.users.doctor);
    await findByText(/synthetic chief complaint/i);
    const calls = mock.getSummary.mock.calls.length;
    await act(async () => live.summary?.({ consultationId: 'other', reason: 'drafted' }));
    expect(mock.getSummary.mock.calls.length).toBe(calls);
  });

  it('finalizing saves the assigned doctor’s unsaved draft first, after confirmation', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    mock.getSummary.mockRejectedValue(new Error('no draft'));
    mock.draftSummary.mockResolvedValue(
      fixtures.summary({ finalized: false, content: 'Draft text' }),
    );
    mock.finalizeSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { user, findByLabelText, findByRole, getByRole } = render(fixtures.users.doctor);

    await user.type(await findByLabelText(/summary draft/i), 'Draft text');

    // First click only asks for confirmation — nothing is persisted yet.
    await user.click(await findByRole('button', { name: /finalize & sign off/i }));
    expect(mock.finalizeSummary).not.toHaveBeenCalled();
    expect(mock.draftSummary).not.toHaveBeenCalled();

    // Confirming saves the editor content, then finalizes.
    await user.click(getByRole('button', { name: /confirm & finalize/i }));
    await waitFor(() => expect(mock.finalizeSummary).toHaveBeenCalledWith('c-1'));
    expect(mock.draftSummary).toHaveBeenCalledWith('c-1', 'Draft text');
  });

  it('cancels finalize without persisting anything', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    mock.getSummary.mockRejectedValue(new Error('no draft'));
    const { user, findByLabelText, getByRole, queryByRole } = render(fixtures.users.doctor);
    await user.type(await findByLabelText(/summary draft/i), 'Draft text');
    await user.click(getByRole('button', { name: /finalize & sign off/i }));
    await user.click(getByRole('button', { name: /^cancel$/i }));
    expect(mock.finalizeSummary).not.toHaveBeenCalled();
    expect(mock.draftSummary).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: /confirm & finalize/i })).not.toBeInTheDocument();
  });

  it('shows a patient guidance and messages but no clinician controls', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'CLAIMED' }));
    const { findByText, queryByRole, queryByLabelText } = render(fixtures.users.patient);
    expect(await findByText(/will start the session shortly/i)).toBeInTheDocument();
    expect(queryByRole('button', { name: /start session/i })).not.toBeInTheDocument();
    expect(queryByLabelText(/summary draft/i)).not.toBeInTheDocument();
    expect(mock.getSummary).not.toHaveBeenCalled();
  });

  it('surfaces a load error when the consultation cannot be fetched', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getConsultation.mockReset().mockRejectedValue(new ApiError(500, 'Room unavailable'));
    const { findByText } = render(fixtures.users.doctor);
    expect(await findByText(/room unavailable/i)).toBeInTheDocument();
  });

  it('explains when access ends mid-review (e.g. another doctor signed it off)', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getConsultation.mockReset().mockRejectedValue(new ApiError(403, 'Forbidden'));
    const { findByText } = render(fixtures.users.doctor);
    expect(await findByText(/no longer available to you/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByText } = render(fixtures.users.doctor);
    await findByText(/sample patient message/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
