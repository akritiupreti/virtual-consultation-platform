import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../lib/api';
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
vi.mock('../lib/realtime', () => ({
  useConsultationRoom: () => undefined,
}));

function render(user: AuthUser) {
  return renderWithProviders(<ConsultationRoom />, {
    user,
    route: '/consultations/c-1',
    path: '/consultations/:id',
  });
}

describe('ConsultationRoom screen', () => {
  beforeEach(() => {
    mock.getConsultation.mockReset().mockResolvedValue(fixtures.consultation());
    mock.getMessages.mockReset().mockResolvedValue(fixtures.messages);
    mock.getSummary.mockReset().mockResolvedValue(fixtures.summary({ finalized: false }));
    mock.sendMessage.mockReset().mockResolvedValue(fixtures.messages[1]);
    mock.start.mockReset();
    mock.complete.mockReset();
    mock.finalizeSummary.mockReset();
    mock.draftSummary.mockReset();
  });

  it('renders intake, state and messages', async () => {
    const { findByText, getByText } = render(fixtures.users.doctor);
    expect(await findByText(/synthetic chief complaint/i)).toBeInTheDocument();
    expect(getByText(/sample patient message/i)).toBeInTheDocument();
    expect(getByText('IN_SESSION')).toBeInTheDocument();
  });

  it('lets a clinician send a message during the session', async () => {
    const { user, findByPlaceholderText, getByRole } = render(fixtures.users.doctor);
    const input = await findByPlaceholderText(/type a message/i);
    await user.type(input, 'Hello there');
    await user.click(getByRole('button', { name: /send/i }));
    expect(mock.sendMessage).toHaveBeenCalledWith('c-1', 'Hello there');
  });

  it('offers Start session when the case is CLAIMED', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'CLAIMED' }));
    const { user, findByRole } = render(fixtures.users.doctor);
    await user.click(await findByRole('button', { name: /start session/i }));
    expect(mock.start).toHaveBeenCalledWith('c-1');
  });

  it('lets a clinician save a summary draft', async () => {
    const { user, findByLabelText, getByRole } = render(fixtures.users.doctor);
    const draft = await findByLabelText(/summary draft/i);
    await user.type(draft, 'Draft note');
    await user.click(getByRole('button', { name: /save draft/i }));
    expect(mock.draftSummary).toHaveBeenCalled();
  });

  it('offers Finalize & sign off only to a doctor on an ENDED case', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    const { findByRole } = render(fixtures.users.doctor);
    expect(await findByRole('button', { name: /finalize & sign off/i })).toBeInTheDocument();
  });

  it('does not offer Finalize & sign off to a nurse on an ENDED case', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    const { findByText, queryByRole } = render(fixtures.users.nurse);
    // The nurse can still draft, but sign-off is doctor-only.
    await findByText(/a doctor must sign off/i);
    expect(queryByRole('button', { name: /finalize & sign off/i })).not.toBeInTheDocument();
  });

  it('finalizing saves the current draft then locks it, after confirmation', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false, content: '' }));
    mock.draftSummary.mockResolvedValue(fixtures.summary({ finalized: false }));
    mock.finalizeSummary.mockResolvedValue(fixtures.summary({ finalized: true }));
    const { user, findByLabelText, findByRole, getByRole } = render(fixtures.users.doctor);

    // Edit the draft, then sign off in one action (no separate "Save draft" click).
    await user.type(await findByLabelText(/summary draft/i), 'Draft text');

    // First click only asks for confirmation — nothing is persisted yet.
    await user.click(await findByRole('button', { name: /finalize & sign off/i }));
    expect(mock.finalizeSummary).not.toHaveBeenCalled();

    // Confirming saves the editor content, then finalizes.
    await user.click(getByRole('button', { name: /confirm & finalize/i }));
    expect(mock.draftSummary).toHaveBeenCalledWith('c-1', 'Draft text');
    expect(mock.finalizeSummary).toHaveBeenCalledWith('c-1');
  });

  it('cancels finalize without persisting anything', async () => {
    mock.getConsultation.mockResolvedValue(fixtures.consultation({ state: 'ENDED' }));
    mock.getSummary.mockResolvedValue(fixtures.summary({ finalized: false, content: '' }));
    const { user, findByLabelText, getByRole, queryByRole } = render(fixtures.users.doctor);
    await user.type(await findByLabelText(/summary draft/i), 'Draft text');
    await user.click(getByRole('button', { name: /finalize & sign off/i }));
    await user.click(getByRole('button', { name: /cancel/i }));
    expect(mock.finalizeSummary).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: /confirm & finalize/i })).not.toBeInTheDocument();
  });

  it('does not show clinician controls to a patient', async () => {
    const { findByText, queryByRole } = render(fixtures.users.patient);
    await findByText(/synthetic chief complaint/i);
    expect(queryByRole('heading', { name: /clinician controls/i })).not.toBeInTheDocument();
  });

  it('surfaces a load error when the consultation cannot be fetched', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getConsultation.mockReset().mockRejectedValue(new ApiError(403, 'Forbidden room'));
    const { findByText } = render(fixtures.users.doctor);
    expect(await findByText(/forbidden room/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByText } = render(fixtures.users.doctor);
    await findByText(/synthetic chief complaint/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
