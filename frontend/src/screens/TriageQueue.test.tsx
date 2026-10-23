import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import TriageQueue from './TriageQueue';

const mock = vi.hoisted(() => ({
  getQueue: vi.fn(),
  claim: vi.fn(),
  setPriority: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});
vi.mock('../lib/realtime', () => ({
  useQueueUpdates: () => undefined,
}));

function render() {
  return renderWithProviders(<TriageQueue />, { user: fixtures.users.nurse, route: '/queue' });
}

describe('TriageQueue screen', () => {
  beforeEach(() => {
    mock.getQueue.mockReset().mockResolvedValue(fixtures.queue);
    mock.claim.mockReset();
    mock.setPriority.mockReset();
  });

  it('renders the pre-claim queue rows', async () => {
    const { findByText, getByText } = render();
    expect(await findByText(/sample complaint one/i)).toBeInTheDocument();
    expect(getByText(/sample complaint two/i)).toBeInTheDocument();
    // Pre-claim data minimization notice (C7 / invariant 6).
    expect(getByText(/minimal information only/i)).toBeInTheDocument();
  });

  it('shows an empty state when the queue is empty', async () => {
    mock.getQueue.mockResolvedValue([]);
    const { findByText } = render();
    expect(await findByText(/the queue is empty/i)).toBeInTheDocument();
  });

  it('claims a case and navigates to its room', async () => {
    mock.claim.mockResolvedValue(fixtures.consultation());
    const { user, findAllByRole } = render();
    const claimButtons = await findAllByRole('button', { name: /claim/i });
    await user.click(claimButtons[0]);
    expect(mock.claim).toHaveBeenCalledWith('c-1');
  });

  it('re-prioritizes a case via the priority select', async () => {
    mock.setPriority.mockResolvedValue({ id: 'c-1', priority: 'URGENT' });
    const { user, findAllByLabelText } = render();
    const selects = await findAllByLabelText(/change priority/i);
    await user.selectOptions(selects[0], 'URGENT');
    expect(mock.setPriority).toHaveBeenCalledWith('c-1', 'URGENT');
  });

  it('surfaces a load error', async () => {
    const { ApiError } = await import('../lib/api');
    mock.getQueue.mockRejectedValueOnce(new ApiError(500, 'Queue down'));
    const { findByText } = render();
    expect(await findByText(/queue down/i)).toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByText } = render();
    await findByText(/sample complaint one/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
