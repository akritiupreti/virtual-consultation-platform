import type { Page, Route } from '@playwright/test';

/**
 * Renders a critical screen against a fully stubbed backend. The auth token +
 * user are seeded into localStorage before the SPA boots (so RequireRole lets
 * us in), every REST call is answered from synthetic fixtures via page.route,
 * and the socket.io transport is blocked. NONE of the data is real/clinical
 * (invariant 6) — the strings are obvious placeholders.
 */

export type RoleKey = 'patient' | 'nurse' | 'doctor' | 'admin';

const USERS: Record<RoleKey, { id: string; email: string; role: string }> = {
  patient: { id: 'u-patient', email: 'patient@example.test', role: 'PATIENT' },
  nurse: { id: 'u-nurse', email: 'nurse@example.test', role: 'NURSE' },
  doctor: { id: 'u-doctor', email: 'doctor@example.test', role: 'DOCTOR' },
  admin: { id: 'u-admin', email: 'admin@example.test', role: 'ADMIN' },
};

const QUEUE = [
  {
    id: 'c-1',
    priority: 'EMERGENCY',
    symptomCategory: 'Respiratory',
    severity: 5,
    complaintSummary: 'Sample complaint one (synthetic)',
    enqueuedAt: '2026-10-22T09:00:00.000Z',
    waitingSeconds: 600,
  },
  {
    id: 'c-2',
    priority: 'ROUTINE',
    symptomCategory: 'Dermatology',
    severity: 2,
    complaintSummary: 'Sample complaint two (synthetic)',
    enqueuedAt: '2026-10-22T09:05:00.000Z',
    waitingSeconds: 300,
  },
];

const DETAIL = {
  id: 'c-1',
  state: 'IN_SESSION',
  priority: 'URGENT',
  patientId: 'u-patient',
  claimedBy: 'u-doctor',
  createdAt: '2026-10-22T09:00:00.000Z',
  enqueuedAt: '2026-10-22T09:00:05.000Z',
  claimedAt: '2026-10-22T09:02:00.000Z',
  startedAt: '2026-10-22T09:03:00.000Z',
  endedAt: null,
  intake: {
    chiefComplaint: 'Synthetic chief complaint',
    symptomCategory: 'General',
    onsetDuration: '2 days',
    severity: 3,
    history: null,
    medications: null,
    consentAt: '2026-10-22T08:59:00.000Z',
  },
  summaryAvailable: false,
  summaryFinalized: false,
};

const MESSAGES = [
  {
    id: 'm-1',
    senderId: 'u-patient',
    body: 'Sample patient message',
    createdAt: '2026-10-22T09:04:00.000Z',
  },
  {
    id: 'm-2',
    senderId: 'u-doctor',
    body: 'Sample clinician reply',
    createdAt: '2026-10-22T09:04:30.000Z',
  },
];

const SUMMARY = {
  consultationId: 'c-1',
  content: 'Synthetic summary content for testing only.',
  draftedBy: 'u-doctor',
  finalizedBy: 'u-doctor',
  finalizedAt: '2026-10-22T09:10:00.000Z',
  finalized: true,
};

function json(route: Route, bodyObj: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(bodyObj),
  });
}

// Stubs are anchored to the API origin (VITE_API_URL default :3000) so they only
// intercept the app's XHR/fetch calls — never the SPA document or JS served from
// the preview origin (:4173).
const API = 'http://localhost:3000';

async function stubBackend(page: Page): Promise<void> {
  // Order matters: Playwright gives LATER-registered routes priority, so the
  // generic `/consultations/:id` catch-all is registered FIRST and the specific
  // collection routes (queue/mine) LAST so they win for those exact paths.
  await page.route(`${API}/socket.io/**`, (route) => route.abort());
  await page.route(/localhost:3000\/consultations\/[^/]+$/, (route) => json(route, DETAIL));
  await page.route(/localhost:3000\/consultations\/[^/]+\/messages$/, (route) =>
    json(route, MESSAGES),
  );
  await page.route(/localhost:3000\/consultations\/[^/]+\/summary$/, (route) =>
    json(route, SUMMARY),
  );
  await page.route(`${API}/consultations/queue`, (route) => json(route, QUEUE));
  await page.route(`${API}/consultations/mine`, (route) => json(route, []));
  await page.route(/localhost:3000\/audit(\?.*)?$/, (route) =>
    json(route, { items: [], total: 0, limit: 50, offset: 0 }),
  );
  await page.route(`${API}/users`, (route) => json(route, []));
}

async function seedAuth(page: Page, role: RoleKey): Promise<void> {
  const user = USERS[role];
  await page.addInitScript(
    ([u]) => {
      localStorage.setItem('vcp_token', 'test-token');
      localStorage.setItem('vcp_user', JSON.stringify(u));
    },
    [user],
  );
}

/** Critical-screen routes (C25): login, triage queue, consultation room, summary. */
export const SCREENS: { name: string; path: string; role?: RoleKey; ready: string }[] = [
  { name: 'login', path: '/login', ready: 'Log in' },
  { name: 'triage-queue', path: '/queue', role: 'nurse', ready: 'Triage queue' },
  { name: 'consultation-room', path: '/consultations/c-1', role: 'doctor', ready: 'Consultation' },
  {
    name: 'summary',
    path: '/consultations/c-1/summary',
    role: 'doctor',
    ready: 'Clinical summary',
  },
];

export async function openScreen(page: Page, screen: (typeof SCREENS)[number]): Promise<void> {
  await stubBackend(page);
  if (screen.role) {
    await seedAuth(page, screen.role);
  }
  await page.goto(screen.path);
  await page.getByRole('heading', { name: screen.ready }).first().waitFor();
  // Settle the post-load fetch render. We cannot wait for 'networkidle' because
  // the stubbed-out socket.io transport reconnects on a loop by design.
  await page.waitForTimeout(300);
}
