import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * "Quote on Bluesky", offered under a passage the reader has selected.
 *
 * Loaded on the reader's first selection inside the body (see Prose), never
 * with the page: most readers never select anything, and they should not pay
 * for this in the page's first load.
 *
 * One quiet link, under the end of the selection rather than above it, because
 * above is where iOS and Android put their own selection menu. It exists only
 * while there is a selection, and Escape or a click elsewhere puts it away.
 *
 * Keyboard: the link sits in the DOM right after the body, so Tab from the
 * body's last link reaches it, and Enter follows it like any link. Escape hides
 * it and leaves the selection alone. Readers who never select text have the
 * post's own "Share on Bluesky" link in the colophon.
 */
export function PassageShare({
  prose,
  quoteHref,
}: {
  prose: React.RefObject<HTMLElement | null>;
  /** The share link for a passage. Passed in rather than imported, so this
   * chunk shares no module with the page and costs it no extra request. */
  quoteHref: (passage: string) => string;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const link = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    // Not while the reader is still dragging out the selection: a link that
    // chases the pointer is exactly the floating clutter this has to avoid.
    let dragging = false;
    const update = () => {
      // Tabbing to the link must not take the offer away from under it.
      if (link.current && document.activeElement === link.current) return;
      setOffer(dragging ? null : readSelection(prose.current, quoteHref));
    };
    // From pointermove as well as pointerdown, because the drag that made the
    // first selection began before this was loaded. Touch is left out: a long
    // press hands the gesture to the browser's own selection, which ends in
    // pointercancel, and the handles move without any page pointer events.
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      // Pressing the link itself is not a new drag, and must not take the
      // link away before its click lands.
      if (link.current?.contains(event.target as Node)) return;
      const held = event.type !== "pointercancel" && (event.buttons & 1) === 1;
      if (held === dragging) return;
      dragging = held;
      update();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !link.current)
        return;
      // Focus would otherwise fall to <body> with the link it was on.
      if (document.activeElement === link.current) link.current?.blur();
      setOffer(null);
    };
    // Mounted by the selection that loaded it: offer for that one at once.
    update();
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("pointermove", onPointer);
    document.addEventListener("pointerup", onPointer);
    document.addEventListener("pointercancel", onPointer);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("pointermove", onPointer);
      document.removeEventListener("pointerup", onPointer);
      document.removeEventListener("pointercancel", onPointer);
      window.removeEventListener("resize", update);
    };
  }, [prose, quoteHref]);

  // Centred under the selection's last line and kept inside the column:
  // measured once the link has a width to measure, and before paint, so it
  // never shows a frame at its old place.
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    if (!offer || !link.current) return;
    const width = link.current.offsetWidth;
    const room = (prose.current?.clientWidth ?? 0) - width;
    setLeft(Math.max(0, Math.min(offer.center - width / 2, room)));
  }, [offer, prose]);

  if (!offer) return null;
  return (
    <a
      className="absolute z-10 inline-flex min-h-9 items-center border border-ink bg-paper px-3 font-display text-sm text-ink transition-colors hover:bg-ink hover:text-paper pointer-coarse:min-h-11"
      href={offer.href}
      // Leaving the link hands the decision back to the selection.
      onBlur={() => setOffer(readSelection(prose.current, quoteHref))}
      onClick={() => setOffer(null)}
      // Pressing a link clears a selection in most browsers, which would take
      // the link away before its click lands.
      onMouseDown={(event) => event.preventDefault()}
      ref={link}
      rel="noopener noreferrer"
      style={{ left, top: offer.top }}
      target="_blank"
    >
      Quote on Bluesky
      {/* As ExternalLink says it, which can't take this link's ref. */}
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  );
}

type Offer = { href: string; top: number; center: number };

/** Space between the selection's last line and the link. Touch readers get
 * more, so the link clears the selection handle under the last word. */
const GAP_PX = 8;
const TOUCH_GAP_PX = 28;

/**
 * The offer for the current selection, or null when there is none worth
 * quoting: nothing selected, only whitespace, or a selection that starts or
 * ends outside the body (a quote of the byline and half a paragraph is not
 * the writer's sentence).
 */
export function readSelection(
  prose: HTMLElement | null,
  quoteHref: (passage: string) => string,
): Offer | null {
  const selection = window.getSelection();
  if (!prose || !selection || selection.isCollapsed) return null;
  if (!prose.contains(selection.anchorNode)) return null;
  if (!prose.contains(selection.focusNode)) return null;
  const passage = selection.toString();
  if (!passage.trim()) return null;

  // The last line with any selected text on it. A triple-clicked paragraph
  // ends at the start of the next one, which adds an empty rect there.
  const last = Array.from(selection.getRangeAt(0).getClientRects())
    .reverse()
    .find((rect) => rect.width > 0);
  const box = prose.getBoundingClientRect();
  const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return {
    href: quoteHref(passage),
    top: (last ? last.bottom - box.top : 0) + (touch ? TOUCH_GAP_PX : GAP_PX),
    center: last ? (last.left + last.right) / 2 - box.left : 0,
  };
}
