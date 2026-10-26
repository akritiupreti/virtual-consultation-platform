import { FormEvent, JSX, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BrandMark from '../components/BrandMark';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDocumentTitle } from '../lib/hooks';

export default function Login(): JSX.Element {
  const { login, register, signOutReason } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useDocumentTitle(mode === 'login' ? 'Log in' : 'Register');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
      // Replace so the login page drops out of history — pressing Back after
      // signing in must not return to a stale login form.
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <BrandMark />
        <span>Virtual Consultation Platform</span>
      </div>
      <div className="card auth-card">
        <h1>{mode === 'login' ? 'Log in' : 'Register as a patient'}</h1>
        {signOutReason && mode === 'login' && (
          <p className="banner banner-info" role="status">
            {signOutReason}
          </p>
        )}
        <form onSubmit={submit} noValidate={false}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            aria-describedby={mode === 'register' ? 'password-hint' : undefined}
          />
          {mode === 'register' && (
            <p className="hint" id="password-hint">
              At least 8 characters.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
        <p className="auth-switch">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
          </button>
        </p>
      </div>
      <p className="muted auth-footnote">
        Registration creates a patient account. Staff accounts (nurse, doctor, admin) are
        provisioned by an administrator — locally, by the seed script (e.g.{' '}
        <code>nurse@vcp.local</code>).
      </p>
    </div>
  );
}
