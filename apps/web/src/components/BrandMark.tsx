/** The logo: a ring of savers around a shared pot, drawn in the current text colour. Decorative, so it is hidden from screen readers. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
      <circle cx="16" cy="16" r="11" strokeWidth="2.2" strokeDasharray="5.4 2.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
