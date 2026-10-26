import { within } from '@testing-library/react';
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

  it('renders the request form and the current consultation with its queue position', async () => {
    const { findByText, getByLabelText, getByText, queryByText, findByRole } = render();
    expect(await findByRole('heading', { name: /request a consultation/i })).toBeInTheDocument();
    expect(getByLabelText(/main problem/i)).toBeInTheDocument();
    expect(await findByText(/2 people ahead of you/i)).toBeInTheDocument();
    expect(getByText(/sample complaint \(synthetic\)/i)).toBeInTheDocument();
    // The emergency notice was removed at the product owner's request.
    expect(queryByText(/not for emergencies/i)).not.toBeInTheDocument();
  });

  it('separates finished consultations under Past', async () => {
    mock.getMine.mockResolvedValue([
      { ...fixtures.myConsultations[0], id: 'c-9', state: 'SUMMARIZED', summaryAvailable: true },
    ]);
    const { findByRole, queryByRole } = render();
    expect(await findByRole('link', { name: /view summary/i })).toBeInTheDocument();
    expect(queryByRole('heading', { name: /^current$/i })).not.toBeInTheDocument();
  });

  it('requires consent before submitting', async () => {
    const { getByRole, findByRole } = render();
    await findByRole('heading', { name: /request a consultation/i });
    expect(getByRole('button', { name: /submit request/i })).toBeDisabled();
  });

  it('submits a request once the form is complete', async () => {
    const { user, getByLabelText, getByRole } = render();
    await user.type(getByLabelText(/main problem/i), 'Synthetic complaint');
    await user.type(getByLabelText(/onset \/ duration/i), '2 days');
    await user.type(getByLabelText(/current medications/i), 'Synthetic medication');
    await user.click(getByRole('checkbox'));
    await user.click(getByRole('button', { name: /submit request/i }));
    expect(mock.submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        chiefComplaint: 'Synthetic complaint',
        consent: true,
        medications: 'Synthetic medication',
        history: undefined,
      }),
    );
  });

  it('cancels a consultation only after confirmation', async () => {
    const { user, findByRole } = render();
    await user.click(await findByRole('button', { name: /cancel request/i }));
    expect(mock.cancel).not.toHaveBeenCalled();
    const dialog = await findByRole('alertdialog', { name: /confirm cancel request/i });
    await user.click(within(dialog).getByRole('button', { name: /cancel request/i }));
    expect(mock.cancel).toHaveBeenCalledWith('c-1');
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container, findByRole } = render();
    await findByRole('heading', { name: /request a consultation/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
