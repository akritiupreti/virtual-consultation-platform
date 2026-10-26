import { useEffect, useState } from 'react';

const APP_NAME = 'Virtual Consultation Platform';

/** Sets the browser tab title for a screen, e.g. "Triage queue · Virtual Consultation Platform". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}

/**
 * The current time, re-read every `intervalMs`, so relative times ("waiting
 * 12 min") keep counting between server refreshes without refetching anything.
 */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Warn before the tab is closed or reloaded while there is unsaved work (the
 * browser shows its own generic prompt). In-app navigation is guarded by the
 * screen itself, since this router setup has no navigation blocker.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy browsers need returnValue set to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
