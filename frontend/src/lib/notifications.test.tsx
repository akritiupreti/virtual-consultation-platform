import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { JSX, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationProvider, useNotify } from './notifications';

/** A trivial consumer that fires a notification on click. */
function Trigger({ message, tone }: { message: string; tone?: 'info' | 'success' }): JSX.Element {
  const notify = useNotify();
  return (
    <button type="button" onClick={() => notify(message, { tone, duration: 0 })}>
      go
    </button>
  );
}

function setup(ui: JSX.Element) {
  return {
    user: userEvent.setup(),
    ...render(<NotificationProvider>{ui}</NotificationProvider>),
  };
}

describe('NotificationProvider', () => {
  it('exposes a live region that is present (and empty) before any toast', () => {
    const { getByRole } = setup(<Trigger message="noop" />);
    const region = getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('shows a toast in the live region when notify is called', async () => {
    const { user, getByRole, findByText } = setup(
      <Trigger message="A clinician has picked up your consultation." />,
    );
    await user.click(getByRole('button', { name: /go/i }));
    expect(await findByText(/picked up your consultation/i)).toBeInTheDocument();
  });

  it('dismisses a toast via its close button', async () => {
    const { user, getByRole, findByRole, queryByText } = setup(<Trigger message="Dismiss me" />);
    await user.click(getByRole('button', { name: /go/i }));
    await user.click(await findByRole('button', { name: /dismiss notification/i }));
    expect(queryByText(/dismiss me/i)).not.toBeInTheDocument();
  });

  it('throws if useNotify is used outside a provider', () => {
    function Orphan(): JSX.Element {
      useNotify();
      return <span />;
    }
    expect(() => render(<Orphan />)).toThrow(/NotificationProvider/);
  });

  it('has no axe-detectable accessibility violations with a toast shown', async () => {
    const { user, getByRole, container } = setup(
      <Trigger message="Your summary is ready." tone="success" />,
    );
    await user.click(getByRole('button', { name: /go/i }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('NotificationProvider auto-dismiss', () => {
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses a toast after its default duration', () => {
    vi.useFakeTimers();
    function Fires(): JSX.Element {
      const notify = useNotify();
      // Fire once on mount with the default (auto-dismiss) duration.
      useEffect(() => notify('Temporary toast'), [notify]);
      return <span />;
    }
    const { getByText, queryByText } = render(
      <NotificationProvider>
        <Fires />
      </NotificationProvider>,
    );
    expect(getByText(/temporary toast/i)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(queryByText(/temporary toast/i)).not.toBeInTheDocument();
  });
});
