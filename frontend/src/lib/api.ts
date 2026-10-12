/** Thin typed client over the backend REST API (docs/api-spec.md). */

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';
const TOKEN_KEY = 'vcp_token';

export type Role = 'PATIENT' | 'NURSE' | 'DOCTOR' | 'ADMIN';
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
  position: number | null;
  summaryAvailable: boolean;
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

  getAudit: (): Promise<AuditEntry[]> => apiFetch('/audit'),
};
