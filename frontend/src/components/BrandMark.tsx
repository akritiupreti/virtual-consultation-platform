import { JSX } from 'react';

/** The product mark: a medical cross in a rounded square, drawn rather than a glyph. */
export default function BrandMark(): JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor" opacity="0.18" />
      <path d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4z" fill="currentColor" />
    </svg>
  );
}
