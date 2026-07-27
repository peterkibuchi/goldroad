/**
 * Anchor that leaves the current surface in a new tab: genuinely external
 * destinations (Bluesky, third-party canonical homes) and "view it live"
 * jumps from writer chrome, where the writer keeps their dashboard/settings
 * context — unsaved edits included. `noopener noreferrer` keeps the opener
 * window out of the destination's hands, and the visually-hidden suffix
 * tells screen readers what the ↗ glyph only shows sighted readers.
 * Internal navigation never uses this — same tab is the default for a reason.
 */
export function ExternalLink({
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  // Our attributes come after the spread: callers can't accidentally
  // reopen window.opener or retarget the link.
  return (
    <a {...props} rel="noopener noreferrer" target="_blank">
      {children}
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  );
}
