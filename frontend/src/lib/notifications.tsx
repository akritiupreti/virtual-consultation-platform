/**
 * Lightweight in-app notification layer (ADR-0021). A single `aria-live` region
 * at the app root surfaces transient "toast" messages; adding a message both
 * shows it visually and has it announced by assistive technology. This is the
 * delivery mechanism only — it carries whatever text the caller passes and holds
 * no clinical content itself (invariant 6; callers phrase state-only messages).
 *
 * Intentionally dependency-free and in-app only: no browser/OS push, no service
 * worker (deferred — see ADR-0021).
 */
import {
  createContext,
  JSX,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export type NotificationTone = 'info' | 'success';

export interface NotificationItem {
  id: number;
  message: string;
  tone: NotificationTone;
}

export interface NotifyOptions {
  tone?: NotificationTone;
  /** ms before auto-dismiss; 0 keeps the toast until it is dismissed manually. */
  duration?: number;
}

export type NotifyFn = (message: string, options?: NotifyOptions) => void;

const NotificationContext = createContext<NotifyFn | null>(null);

const DEFAULT_DURATION = 7000;

export function NotificationProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number): void => {
    setItems((current) => current.filter((n) => n.id !== id));
  }, []);

  const notify = useCallback<NotifyFn>(
    (message, options = {}) => {
      const id = nextId.current++;
      const tone = options.tone ?? 'info';
      setItems((current) => [...current, { id, message, tone }]);
      const duration = options.duration ?? DEFAULT_DURATION;
      if (duration > 0) {
        timers.current.push(window.setTimeout(() => dismiss(id), duration));
      }
    },
    [dismiss],
  );

  // Clear any pending auto-dismiss timers when the provider unmounts.
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  return (
    <NotificationContext.Provider value={notify}>
      {children}
      <NotificationRegion items={items} onDismiss={dismiss} />
    </NotificationContext.Provider>
  );
}

function NotificationRegion({
  items,
  onDismiss,
}: {
  items: NotificationItem[];
  onDismiss: (id: number) => void;
}): JSX.Element {
  // role="status" + aria-live="polite": additions are announced without
  // interrupting the user. The region stays mounted (empty when idle) so a later
  // insertion is reliably picked up by screen readers.
  return (
    <div className="toast-region" role="status" aria-live="polite" aria-relevant="additions">
      {items.map((n) => (
        <div key={n.id} className={`toast toast-${n.tone}`}>
          <span className="toast-msg">{n.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(n.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Access the `notify` function. Must be called under a {@link NotificationProvider};
 * throwing here surfaces a wiring mistake immediately rather than silently dropping
 * notifications.
 */
export function useNotify(): NotifyFn {
  const notify = useContext(NotificationContext);
  if (!notify) {
    throw new Error('useNotify must be used within a NotificationProvider');
  }
  return notify;
}
