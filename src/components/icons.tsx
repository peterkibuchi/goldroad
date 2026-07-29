/**
 * Minimal line icons for the calm reading surfaces — stroke-only, no fill,
 * matching the register's near-zero-ornament rule. Hand-drawn (not a pulled
 * icon-library path) and deliberately plain: currentColor-only, so they sit
 * quietly at ink-soft until a parent hover lifts them to ink, never a
 * colored badge or filled glyph that would read as generic social chrome.
 * Attributes are written literally (not spread from a shared object) so the
 * a11y linter can see `aria-hidden` on each element.
 */

type IconProps = { className?: string };

export function HeartIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      <path d="M12 19.5s-7-4.35-9-8.5c-1.5-3.1.3-6.4 3.2-7 1.9-.4 3.6.5 4.8 2.1 1.2-1.6 2.9-2.5 4.8-2.1 2.9.6 4.7 3.9 3.2 7-2 4.15-9 8.5-9 8.5Z" />
    </svg>
  );
}

export function ReplyIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      <path d="M4 5.5h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

export function RepostIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      <path d="M6 7h10a3 3 0 0 1 3 3v2M18 17H8a3 3 0 0 1-3-3v-2M8.5 4.5 6 7l2.5 2.5M15.5 19.5 18 17l-2.5-2.5" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.35-4.35" />
    </svg>
  );
}
