import { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Walks one step back in history. Rendered on the deep screens (consultation
 * room, summary) so there is always a way back without the browser chrome.
 * `confirmLeave` asks before leaving, e.g. while a summary has unsaved changes.
 */
export default function BackButton({
  label = '← Back',
  confirmLeave,
}: {
  label?: string;
  confirmLeave?: string;
}): JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="link-btn back-link"
      onClick={() => {
        if (confirmLeave && !window.confirm(confirmLeave)) {
          return;
        }
        navigate(-1);
      }}
    >
      {label}
    </button>
  );
}
