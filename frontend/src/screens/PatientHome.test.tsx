import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixtures from '../test/fixtures';
import { renderWithProviders } from '../test/render';
import PatientHome from './PatientHome';

const mock = vi.hoisted(() => ({
  getMine: vi.fn(),
  submitRequest: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});
vi.mock('../lib/realtime', () => ({ usePatientUpdates: () => undefined }));

function render() {
  return renderWithProviders(<PatientHome />, { user: fixtures.users.patient, route: '/patient' });
}

describe('PatientHome screen', () => {
  beforeEach(() => {
    mock.getMine.mockReset().mockResolvedValue(fixtures.myConsultations);
    mock.submitRequest.mockReset().mockResolvedValue(fixtures.myConsultations[0]);
    mock.cancel.mockReset().mockResolvedValue(fixtures.consultation());
  });

  it('renders the request form and current status', async () => {
    const { findByText, getByLabelText } = render();
    expect(await findByText(/request a consultation/i)).toBeInTheDocument();
    expect(getByLabelText(/chief complaint/i)).toBeInTheDocument();
    expect(await findByText(/ahead of you/i)).toBeInTheDocument();
  });

  it('requires consent before submitting', async () => {
    const { getByRole, findByText } = render();
    await findByText(/request a consultation/i);
    expect(getByRole('button', { name: /submit request/i })).toBeDisabled();
  });

  it('submits a request once the form is complete', async () => {
    const { user, getByLabelText, getByRole } = render();
    await user.type(getByLabelText(/chief complaint/i), 'Synthetic complaint');
    await user.type(getByLabelText(/onset \/ duration/i), '2 days');
    await user.click(getByRole('checkbox'));
    await user.click(getByRole('button', { name: /submit request/i }));
    expect(mock.submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({ chiefComplaint: 'Synthetic complaint', consent: true }),
    );
  });

  it('cancels a cancellable consultation', async () => {
    const { user, findByRole } = render();
    await user.click(await findByRole('button', { name: /cancel/i }));
    expect(mock.cancel).toHaveBeenCalledWith('c-1');
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByText } = render();
    await findByText(/request a consultation/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
