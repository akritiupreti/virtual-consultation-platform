import { JSX, ReactNode, useEffect, useRef } from 'react';

/**
 * Inline confirmation for an action that is hard to undo (finalize, end a session,
 * cancel a request, deactivate an account). It appears where the action was taken
 * rather than in a modal, and moves focus to the confirming button so a keyboard
 * user lands on the decision; Escape backs out.
 */
export default function ConfirmPanel({
  label,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
}: {
  /** Accessible name for the dialog, e.g. "Confirm finalize". */
  label: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className={`confirm${danger ? ' confirm-danger' : ''}`}
      role="alertdialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onCancel();
        }
      }}
    >
      <div className="confirm-body">{children}</div>
      <div className="actions">
        <button
          ref={confirmRef}
          type="button"
          className={danger ? 'danger-solid' : undefined}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
