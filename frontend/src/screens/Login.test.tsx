import { axe } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render';
import Login from './Login';

// Mock the API module but keep the real ApiError / token helpers that
// AuthProvider depends on.
const { login, register } = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, login, register } };
});

const authResult = {
  accessToken: 'tok',
  user: { id: 'u-patient', email: 'patient@example.test', role: 'PATIENT' as const },
};

describe('Login screen', () => {
  beforeEach(() => {
    login.mockReset();
    register.mockReset();
  });

  it('renders the login form with labelled fields', () => {
    const { getByRole, getByLabelText } = renderWithProviders(<Login />);
    expect(getByRole('heading', { name: /log in/i })).toBeInTheDocument();
    expect(getByLabelText(/email/i)).toBeInTheDocument();
    expect(getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('toggles to register mode', async () => {
    const { user, getByRole } = renderWithProviders(<Login />);
    await user.click(getByRole('button', { name: /need an account\? register/i }));
    expect(getByRole('heading', { name: /register as a patient/i })).toBeInTheDocument();
  });

  it('submits credentials to the login API', async () => {
    login.mockResolvedValueOnce(authResult);
    const { user, getByLabelText, getByRole } = renderWithProviders(<Login />);
    await user.type(getByLabelText(/email/i), 'patient@example.test');
    await user.type(getByLabelText(/password/i), 'Password123!');
    await user.click(getByRole('button', { name: /^log in$/i }));
    expect(login).toHaveBeenCalledWith('patient@example.test', 'Password123!');
  });

  it('registers when in register mode', async () => {
    register.mockResolvedValueOnce(authResult);
    const { user, getByLabelText, getByRole } = renderWithProviders(<Login />);
    await user.click(getByRole('button', { name: /need an account\? register/i }));
    await user.type(getByLabelText(/email/i), 'new@example.test');
    await user.type(getByLabelText(/password/i), 'Password123!');
    await user.click(getByRole('button', { name: /create account/i }));
    expect(register).toHaveBeenCalledWith('new@example.test', 'Password123!');
  });

  it('shows a readable error when the API rejects', async () => {
    const { ApiError } = await import('../lib/api');
    login.mockRejectedValueOnce(new ApiError(401, 'Invalid credentials'));
    const { user, getByLabelText, getByRole, findByText } = renderWithProviders(<Login />);
    await user.type(getByLabelText(/email/i), 'patient@example.test');
    await user.type(getByLabelText(/password/i), 'wrong');
    await user.click(getByRole('button', { name: /^log in$/i }));
    expect(await findByText(/invalid credentials/i)).toBeInTheDocument();
  });

  it('supports keyboard-only entry and submit (NFR-6)', async () => {
    login.mockResolvedValueOnce(authResult);
    const { user, getByLabelText } = renderWithProviders(<Login />);
    await user.tab();
    expect(getByLabelText(/email/i)).toHaveFocus();
    await user.keyboard('patient@example.test');
    await user.tab();
    expect(getByLabelText(/password/i)).toHaveFocus();
    await user.keyboard('Password123!{Enter}');
    expect(login).toHaveBeenCalledWith('patient@example.test', 'Password123!');
  });

  it('has no axe-detectable accessibility violations (WCAG 2.1 AA)', async () => {
    const { container } = renderWithProviders(<Login />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
