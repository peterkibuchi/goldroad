/**
 * Skip to content (WCAG 2.4.1).
 *
 * Every surface here puts real navigation ahead of the words: the marketing
 * header, the writer's rail, the footer band. A keyboard or screen-reader
 * visitor otherwise walks that furniture again on every page before reaching
 * anything they came for.
 *
 * Hidden until focused, and only until focused — `sr-only` keeps it out of the
 * layout, `focus:not-sr-only` hands it back. Fixed rather than absolute so it
 * needs no positioned ancestor: it is the first child of chrome that is itself
 * sticky, full-bleed, or a flex row, and none of those want a positioning
 * context added underneath them.
 *
 * The target carries `tabIndex={-1}`. Fragment navigation moves the sequential
 * focus starting point in current browsers, but not focus itself everywhere,
 * and a skip link that moves the viewport while leaving focus in the header is
 * the failure the link exists to prevent. `-1` keeps it out of the tab order
 * while making it a legal focus target; programmatic focus is not
 * `:focus-visible`, so no ring appears.
 */
export const MAIN_CONTENT_ID = "main-content";

export function SkipToContent() {
  return (
    <a
      className="sr-only font-bold font-display text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:border-2 focus:border-ink focus:bg-paper focus:px-4 focus:text-ink"
      href={`#${MAIN_CONTENT_ID}`}
    >
      Skip to content
    </a>
  );
}
