import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AuthUser } from '../lib/api';
import { AuthProvider } from '../lib/auth';

interface Options {
  /** Seed an authenticated user (writes the same localStorage keys the app uses). */
  user?: AuthUser | null;
  /** Initial router entry, e.g. '/consultations/c-1'. */
  route?: string;
  /** When set, mounts `ui` under this route path so `useParams` resolves. */
  path?: string;
}

export interface RenderWithProviders extends RenderResult {
  user: ReturnType<typeof userEvent.setup>;
}

/**
 * Render a screen inside the real Router + AuthProvider. Auth is seeded via the
 * same localStorage keys `lib/auth` reads, so no source change is needed to
 * inject a user. Returns a configured user-event instance for keyboard/typing.
 */
export function renderWithProviders(ui: ReactElement, options: Options = {}): RenderWithProviders {
  const { user = null, route = '/', path } = options;

  if (user) {
    localStorage.setItem('vcp_token', 'test-token');
    localStorage.setItem('vcp_user', JSON.stringify(user));
  }

  const tree = (
    <MemoryRouter
      initialEntries={[route]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        {path ? <Routes>{<Route path={path} element={ui} />}</Routes> : ui}
      </AuthProvider>
    </MemoryRouter>
  );

  return { user: userEvent.setup(), ...render(tree) };
}
