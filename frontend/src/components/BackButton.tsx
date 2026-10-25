import { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Walks one step back in history. Rendered on the deep screens (consultation
 * room, summary) so there is always a way back without the browser chrome.
 */
export default function BackButton({ label = '← Back' }: { label?: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" className="link-btn" onClick={() => navigate(-1)}>
      {label}
    </button>
  );
}
