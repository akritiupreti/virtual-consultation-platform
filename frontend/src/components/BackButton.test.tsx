import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import BackButton from './BackButton';

// A two-screen router seeded with history (index 1 = /second), so clicking Back
// pops to /first. This exercises navigate(-1) through the real router.
function renderAt() {
  return render(
    <MemoryRouter
      initialEntries={['/first', '/second']}
      initialIndex={1}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/first" element={<p>first screen</p>} />
        <Route path="/second" element={<BackButton label="← Back" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BackButton', () => {
  it('renders a labelled button', () => {
    const { getByRole } = renderAt();
    expect(getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('navigates one step back in history when clicked', async () => {
    const user = userEvent.setup();
    const { getByRole, findByText } = renderAt();
    await user.click(getByRole('button', { name: /back/i }));
    expect(await findByText('first screen')).toBeInTheDocument();
  });
});
