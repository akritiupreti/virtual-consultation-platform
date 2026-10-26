import { describe, expect, it, vi } from 'vitest';
import App from './App';
import * as fixtures from './test/fixtures';
import { renderWithProviders } from './test/render';

// App pulls in every screen; stub the API and realtime so route changes don't
// perform real I/O. We only assert which screen a route/role resolves to.
vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  const resolve = vi.fn().mockResolvedValue([]);
  return {
    ...actual,
    api: new Proxy(actual.api, { get: () => resolve }),
  };
});
vi.mock('./lib/realtime', () => ({
  useQueueUpdates: () => undefined,
  usePatientUpdates: () => undefined,
  useConsultationRoom: () => undefined,
  useSummaryChangeRequests: () => undefined,
  useSummaryUpdates: () => undefined,
  useAssignedUpdates: () => undefined,
  disconnectRealtime: () => undefined,
}));

describe('App routing & RequireRole', () => {
  it('redirects an unauthenticated visitor to login', async () => {
    const { findByRole } = renderWithProviders(<App />, { route: '/queue' });
    expect(await findByRole('heading', { name: /log in/i })).toBeInTheDocument();
  });

  it('sends a clinician from the fallback route to the triage queue', async () => {
    const { findByRole } = renderWithProviders(<App />, { user: fixtures.users.nurse, route: '/' });
    expect(await findByRole('heading', { name: /triage queue/i })).toBeInTheDocument();
  });

  it('redirects an admin away from the queue to the audit log', async () => {
    const { findByRole } = renderWithProviders(<App />, {
      user: fixtures.users.admin,
      route: '/queue',
    });
    expect(await findByRole('heading', { name: /audit log/i })).toBeInTheDocument();
  });

  it('renders the patient home for a patient', async () => {
    const { findByRole } = renderWithProviders(<App />, {
      user: fixtures.users.patient,
      route: '/patient',
    });
    expect(await findByRole('heading', { name: /my consultations/i })).toBeInTheDocument();
  });

  it('shows the nav bar with the signed-in user', async () => {
    const { findByText } = renderWithProviders(<App />, {
      user: fixtures.users.doctor,
      route: '/queue',
    });
    expect(await findByText(fixtures.users.doctor.email)).toBeInTheDocument();
  });

  it('bounces an already-authenticated user away from /login (Back-button fix)', async () => {
    const { findByRole } = renderWithProviders(<App />, {
      user: fixtures.users.patient,
      route: '/login',
    });
    // Must land on their home, NOT render the login form alongside the nav bar.
    expect(await findByRole('heading', { name: /my consultations/i })).toBeInTheDocument();
  });

  it('renders the admin user-management screen at /users', async () => {
    const { findByRole } = renderWithProviders(<App />, {
      user: fixtures.users.admin,
      route: '/users',
    });
    expect(await findByRole('heading', { name: /^users$/i })).toBeInTheDocument();
  });
});
