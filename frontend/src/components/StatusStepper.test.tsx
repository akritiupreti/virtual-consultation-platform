import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import StatusStepper from './StatusStepper';

describe('StatusStepper', () => {
  it('renders every step of the consultation state machine, in order', () => {
    const { getAllByRole } = render(<StatusStepper state="REQUESTED" />);
    const labels = getAllByRole('listitem').map((li) => li.textContent?.replace(/\s*\(.*\)$/, ''));
    expect(labels).toEqual([
      'Requested',
      'Queued',
      'With clinician',
      'In session',
      'Ended',
      'Summary ready',
    ]);
  });

  it('marks the active state with aria-current and the prior steps as done', () => {
    const { getByText } = render(<StatusStepper state="CLAIMED" />);
    const current = getByText('With clinician').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(current).toHaveClass('is-current');

    // An earlier step is completed, a later one is not started.
    expect(getByText('Queued').closest('li')).toHaveClass('is-done');
    expect(getByText('Ended').closest('li')).toHaveClass('is-todo');
  });

  it('exposes done / not-started status to assistive tech as text', () => {
    const { getByText } = render(<StatusStepper state="IN_SESSION" />);
    expect(getByText('Requested').closest('li')).toHaveTextContent(/\(completed\)/);
    expect(getByText('Summary ready').closest('li')).toHaveTextContent(/\(not started\)/);
  });

  it('shows the final step as current when the summary is ready', () => {
    const { getByText } = render(<StatusStepper state="SUMMARIZED" />);
    expect(getByText('Summary ready').closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('renders a terminal notice for a cancelled consultation (not the stepper)', () => {
    const { getByText, queryByRole } = render(<StatusStepper state="CANCELLED" />);
    expect(getByText(/consultation cancelled/i)).toBeInTheDocument();
    expect(queryByRole('list')).not.toBeInTheDocument();
  });

  it('has no axe-detectable accessibility violations', async () => {
    const { container } = render(<StatusStepper state="CLAIMED" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
