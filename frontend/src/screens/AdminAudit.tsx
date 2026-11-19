import { FormEvent, JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, AuditEntry, AuditQuery, UserAccount } from '../lib/api';
import { formatDateTime, formatTime, humanize, shortId } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';

const PAGE_SIZE = 50;

/** Event types the backend records (backend/src/audit/audit-events.ts). */
const EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'CONSULTATION_REQUESTED',
  'CONSULTATION_ENQUEUED',
  'CONSULTATION_CLAIMED',
  'CONSULTATION_REQUEUED',
  'CONSULTATION_STARTED',
  'CONSULTATION_COMPLETED',
  'CONSULTATION_CANCELLED',
  'PRIORITY_CHANGED',
  'MESSAGE_SENT',
  'SUMMARY_DRAFTED',
  'SUMMARY_FINALIZED',
];

/** Metadata keys whose value is a user id, shown as that account's email. */
const USER_ID_KEYS = new Set(['draftedBy', 'previousClaimedBy', 'targetUserId', 'userId']);

interface Filters {
  eventType: string;
  actorId: string;
  consultationId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { eventType: '', actorId: '', consultationId: '', from: '', to: '' };

/** Date inputs give a calendar day; the API wants an inclusive instant range. */
function toQuery(filters: Filters, offset: number): AuditQuery {
  return {
    eventType: filters.eventType || undefined,
    actorId: filters.actorId || undefined,
    consultationId: filters.consultationId.trim() || undefined,
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined,
    limit: PAGE_SIZE,
    offset,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin audit log (FR-15): who did what, when — never clinical content (separation
 * of duties, invariant 3). Server-side filters and pagination; actor ids are shown
 * as the account email from the user directory admins already manage.
 */
export default function AdminAudit(): JSX.Element {
  useDocumentTitle('Audit log');
  const [page, setPage] = useState<{ items: AuditEntry[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const emailById = useMemo(() => new Map(users.map((u) => [u.id, u.email])), [users]);

  const load = useCallback(async () => {
    try {
      const result = await api.getAudit(toQuery(filters, offset));
      setPage({ items: result.items ?? [], total: result.total ?? 0 });
      setError(null);
      setUpdatedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the audit log');
    }
  }, [filters, offset]);

  useEffect(() => {
    void load();
    // Keep the newest page live; older pages stay still while being read.
    if (offset !== 0) {
      return;
    }
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load, offset]);

  useEffect(() => {
    api
      .getUsers()
      .then(setUsers)
      .catch(() => undefined);
  }, []);

  function apply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (draft.consultationId.trim() && !UUID.test(draft.consultationId.trim())) {
      setError('Consultation ID must be a full ID (e.g. copied from a row).');
      return;
    }
    if (draft.from && draft.to && draft.from > draft.to) {
      setError('The "From" date must be on or before the "To" date.');
      return;
    }
    setError(null);
    setOffset(0);
    setFilters(draft);
  }

  function reset(): void {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setOffset(0);
    setError(null);
  }

  function filterBy(patch: Partial<Filters>): void {
    const next = { ...filters, ...patch };
    setDraft(next);
    setFilters(next);
    setOffset(0);
  }

  function who(id: string | null): string {
    if (!id) {
      return 'System';
    }
    return emailById.get(id) ?? shortId(id);
  }

  function renderMetadata(metadata: unknown): JSX.Element | string {
    if (!metadata || typeof metadata !== 'object') {
      return metadata == null ? '—' : String(metadata);
    }
    // The correlation id ties a row to its request's log lines (SC-15); it is shown
    // last, shortened, with the full value on hover for searching the logs.
    const entries = Object.entries(metadata as Record<string, unknown>).sort(
      ([a], [b]) => Number(a === 'correlationId') - Number(b === 'correlationId'),
    );
    if (entries.length === 0) {
      return '—';
    }
    return (
      <dl className="kv">
        {entries.map(([key, value]) => (
          <div key={key} className={`kv-item${key === 'correlationId' ? ' kv-trace' : ''}`}>
            <dt>
              {key === 'correlationId'
                ? 'Trace id'
                : humanize(key.replace(/([a-z])([A-Z])/g, '$1_$2'))}
            </dt>
            <dd title={typeof value === 'string' ? value : undefined}>
              {metadataValue(key, value)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  /** One metadata value, readable: emails for user ids, short ids, labels. */
  function metadataValue(key: string, value: unknown): string {
    if (typeof value === 'string') {
      if (USER_ID_KEYS.has(key)) {
        return who(value);
      }
      if (UUID.test(value)) {
        return shortId(value);
      }
      return /^[A-Z][A-Z_]+$/.test(value) ? humanize(value) : value;
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Audit log</h1>
          <p className="muted">
            System activity only — who, what, and when. No clinical content (messages or summaries)
            is ever shown here (separation of duties).
          </p>
        </div>
      </div>

      <form className="card filters" onSubmit={apply} aria-label="Filter audit events">
        <div>
          <label htmlFor="f-event">Event</label>
          <select
            id="f-event"
            value={draft.eventType}
            onChange={(e) => setDraft({ ...draft, eventType: e.target.value })}
          >
            <option value="">All events</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-actor">Actor</label>
          <select
            id="f-actor"
            value={draft.actorId}
            onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}
          >
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-consultation">Consultation ID</label>
          <input
            id="f-consultation"
            value={draft.consultationId}
            placeholder="Full ID"
            onChange={(e) => setDraft({ ...draft, consultationId: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="f-from">From</label>
          <input
            id="f-from"
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="f-to">To</label>
          <input
            id="f-to"
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </div>
        <div className="filters-actions">
          <button type="submit">Apply</button>
          <button type="button" className="secondary" onClick={reset} disabled={!hasFilters}>
            Reset
          </button>
        </div>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="card card-flush">
        <div className="table-toolbar">
          <span className="muted" aria-live="polite">
            {page
              ? total === 0
                ? 'No events'
                : `Showing ${offset + 1}–${offset + items.length} of ${total}`
              : ''}
          </span>
          <span className="muted">
            {updatedAt && `Updated ${formatTime(updatedAt)}`}
            {offset === 0 && ' · refreshes automatically'}
          </span>
        </div>
        {page === null && !error ? (
          <p className="muted empty" aria-live="polite">
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="muted empty">
            {hasFilters ? 'No events match these filters.' : 'No audit events yet.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Consultation</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{formatDateTime(e.createdAt)}</td>
                    <td>
                      <span className="event-name" title={e.eventType}>
                        {humanize(e.eventType)}
                      </span>
                    </td>
                    <td className="cell-actor">
                      {e.actorId ? (
                        <button
                          type="button"
                          className="link-btn cell-link"
                          title="Show only this actor"
                          onClick={() => filterBy({ actorId: e.actorId ?? '' })}
                        >
                          {who(e.actorId)}
                        </button>
                      ) : (
                        <span className="muted">System</span>
                      )}
                    </td>
                    <td>
                      {e.consultationId ? (
                        <button
                          type="button"
                          className="link-btn cell-link mono"
                          title={`Show only consultation ${e.consultationId}`}
                          onClick={() => filterBy({ consultationId: e.consultationId ?? '' })}
                        >
                          {shortId(e.consultationId)}
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="cell-wrap">{renderMetadata(e.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE && (
          <nav className="pagination" aria-label="Audit log pages">
            <button
              type="button"
              className="secondary btn-sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Newer
            </button>
            <span className="muted">
              Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(total / PAGE_SIZE)}
            </span>
            <button
              type="button"
              className="secondary btn-sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Older →
            </button>
          </nav>
        )}
      </div>
    </>
  );
}
