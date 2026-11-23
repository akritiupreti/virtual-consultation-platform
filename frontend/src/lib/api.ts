/** Thin typed client over the backend REST API (docs/api-spec.md). */

export const BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';
const TOKEN_KEY = 'vcp_token';

export type Role = 'PATIENT' | 'NURSE' | 'DOCTOR' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'DEACTIVATED';
export type Priority = 'ROUTINE' | 'URGENT' | 'EMERGENCY';
export type ConsultationState =
  'REQUESTED' | 'QUEUED' | 'CLAIMED' | 'IN_SESSION' | 'ENDED' | 'SUMMARIZED' | 'CANCELLED';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface AuthResult {
  accessToken: string;
  user: AuthUser;
}

export interface QueueItem {
  id: string;
  priority: Priority;
  symptomCategory: string;
  severity: number;
  complaintSummary: string;
  enqueuedAt: string | null;
  waitingSeconds: number;
}

export interface MyConsultation {
  id: string;
  state: ConsultationState;
  priority: Priority;
  createdAt: string;
  /** A short label of the patient's own chief complaint. */
  complaintSummary: string;
  position: number | null;
  summaryAvailable: boolean;
}

/** A clinician's view of a case assigned to them (see backend getAssigned). */
export interface AssignedConsultation {
  id: string;
  state: ConsultationState;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  claimedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** A draft exists; an ENDED case without one cannot reach a doctor's sign-off. */
  summaryDrafted: boolean;
  summaryFinalized: boolean;
}

/**
 * A doctor's "pending sign-off" worklist row — a case (typically nurse-run) left
 * in ENDED with a drafted-but-unfinalized summary. Minimal detail only; the doctor
 * opens the room to review the full narrative and finalize (see backend getPendingSignoff).
 */
export interface PendingSignoff {
  id: string;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  endedAt: string | null;
  draftedBy: string;
  draftedAt: string | null;
}

/** A case the calling doctor signed off — their own review history (ADR-0009). */
export interface SignedOff {
  id: string;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  endedAt: string | null;
  finalizedAt: string | null;
  draftedBy: string;
}

export interface ConsultationDetail {
  id: string;
  state: ConsultationState;
  priority: Priority;
  patientId: string;
  claimedBy: string | null;
  createdAt: string;
  enqueuedAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  intake: {
    chiefComplaint: string;
    symptomCategory: string;
    onsetDuration: string;
    severity: number;
    history: string | null;
    medications: string | null;
    consentAt: string;
  } | null;
  summaryAvailable: boolean;
  summaryFinalized: boolean;
}

export interface Message {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface Summary {
  consultationId: string;
  content: string;
  draftedBy: string;
  finalizedBy: string | null;
  finalizedAt: string | null;
  finalized: boolean;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  eventType: string;
  consultationId: string | null;
  metadata: unknown;
  createdAt: string;
}

/** Optional filters for the admin audit query (docs/api-spec.md). */
export interface AuditQuery {
  eventType?: string;
  actorId?: string;
  consultationId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Admin audit read is paginated server-side (docs/api-spec.md). */
export interface AuditPage {
  items: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** Account as returned by the admin user-management endpoints (never clinical content). */
export interface UserAccount {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}

export interface SubmitRequestInput {
  chiefComplaint: string;
  symptomCategory: string;
  onsetDuration: string;
  severity: number;
  consent: boolean;
  priority?: Priority;
  history?: string;
  medications?: string;
}

/**
 * Called when an authenticated request comes back 401 — the JWT expired or the
 * account was deactivated. The auth layer registers a handler that signs the user
 * out, so the app never sits "logged in" while every call fails.
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage unavailable (private mode) — token stays in memory for this session */
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      }
    } catch {
      /* non-JSON error body */
    }
    // Only a request that carried a token can have an expired session; a failed
    // login is a plain 401 the login form shows itself.
    if (res.status === 401 && token) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

const body = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) });

export const api = {
  register: (email: string, password: string): Promise<AuthResult> =>
    apiFetch('/auth/register', body({ email, password })),
  login: (email: string, password: string): Promise<AuthResult> =>
    apiFetch('/auth/login', body({ email, password })),

  submitRequest: (input: SubmitRequestInput): Promise<MyConsultation> =>
    apiFetch('/consultations', body(input)),
  getMine: (): Promise<MyConsultation[]> => apiFetch('/consultations/mine'),
  getAssigned: (): Promise<AssignedConsultation[]> => apiFetch('/consultations/assigned'),
  getPendingSignoff: (): Promise<PendingSignoff[]> => apiFetch('/consultations/pending-signoff'),
  getSignedOff: (): Promise<SignedOff[]> => apiFetch('/consultations/signed-off'),
  getQueue: (): Promise<QueueItem[]> => apiFetch('/consultations/queue'),
  getConsultation: (id: string): Promise<ConsultationDetail> => apiFetch(`/consultations/${id}`),
  claim: (id: string): Promise<ConsultationDetail> =>
    apiFetch(`/consultations/${id}/claim`, body({})),
  start: (id: string): Promise<ConsultationDetail> =>
    apiFetch(`/consultations/${id}/start`, body({})),
  complete: (id: string): Promise<ConsultationDetail> =>
    apiFetch(`/consultations/${id}/complete`, body({})),
  cancel: (id: string): Promise<ConsultationDetail> =>
    apiFetch(`/consultations/${id}/cancel`, body({})),
  setPriority: (id: string, priority: Priority): Promise<{ id: string; priority: Priority }> =>
    apiFetch(`/consultations/${id}/priority`, {
      method: 'PATCH',
      body: JSON.stringify({ priority }),
    }),

  getMessages: (id: string): Promise<Message[]> => apiFetch(`/consultations/${id}/messages`),
  sendMessage: (id: string, text: string): Promise<Message> =>
    apiFetch(`/consultations/${id}/messages`, body({ body: text })),

  draftSummary: (id: string, content: string): Promise<Summary> =>
    apiFetch(`/consultations/${id}/summary`, body({ content })),
  finalizeSummary: (id: string): Promise<Summary> =>
    apiFetch(`/consultations/${id}/summary/finalize`, body({})),
  getSummary: (id: string): Promise<Summary> => apiFetch(`/consultations/${id}/summary`),

  // The server paginates and filters the audit trail ({ items, total, limit, offset }).
  // Empty filters are dropped so they never reach the query string as blanks.
  getAudit: (query: AuditQuery = {}): Promise<AuditPage> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    return apiFetch(`/audit${qs ? `?${qs}` : ''}`);
  },

  // Admin user management (admin-only endpoints — no clinical content).
  getUsers: (): Promise<UserAccount[]> => apiFetch('/users'),
  deactivateUser: (id: string): Promise<UserAccount> =>
    apiFetch(`/users/${id}/deactivate`, body({})),
  reactivateUser: (id: string): Promise<UserAccount> =>
    apiFetch(`/users/${id}/reactivate`, body({})),
};
