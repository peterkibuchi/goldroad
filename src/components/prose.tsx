import { useEffect, useRef, useState } from "react";

import type { PassageShare } from "~/components/passage-share";

/** A block that names a language, other than the names that mean "plain". */
const HIGHLIGHTABLE =
  "pre > code[class*='language-']:not(.language-text,.language-txt,.language-plaintext)";

/**
 * The writer's body on a reading page, as HTML from ~/lib/markdown-html,
 * which is where the safety rules live: raw HTML escaped, links and images
 * limited to safe URLs. Rendered on the server (or once in the loader on
 * client navigation) and never re-parsed during hydration.
 *
 * `gr-prose` is a styling hook: it marks the writer's own prose so a themed
 * page can put their accent on the links inside it without recolouring page
 * chrome (see [data-writer-theme] in styles.css).
 *
 * It also loads embeds. Each one renders as a link to the original (see
 * ~/lib/embeds); a plain click on it swaps that link for a player in place.
 * The player is our own same-origin frame page, which is the only page that
 * may frame the provider, so this page's own policy never has to.
 *
 * Given `quoteHref`, it offers a selected passage as a quote on Bluesky
 * (~/components/passage-share). All the page carries for that is the listener
 * below; the offer itself loads when a reader first selects text in the body.
 *
 * And it colours fenced code (~/lib/highlight-code), which loads only for a
 * body with a block that names its language.
 */
export function Prose({
  html,
  quoteHref,
}: {
  html: string;
  /** The share link for a selected passage; no offer without one. */
  quoteHref?: (passage: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The offer's code, fetched on the reader's first selection in the body,
  // never with the page. Not React.lazy: a chunk that fails to load (a deploy
  // since the page was opened, a dropped connection) would throw through
  // Suspense to the route's error page and take the post with it. Here the
  // reader just gets no offer.
  const [Offer, setOffer] = useState<typeof PassageShare | null>(null);

  useEffect(() => {
    if (!quoteHref) return;
    const onSelect = () => {
      const selection = window.getSelection();
      if (selection?.isCollapsed !== false) return;
      if (!ref.current?.contains(selection.anchorNode)) return;
      document.removeEventListener("selectionchange", onSelect);
      import("~/components/passage-share")
        .then((module) => setOffer(() => module.PassageShare))
        .catch(() => {});
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, [quoteHref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `html` is read through the DOM, not the closure: a client-side move to another post swaps the body in place, and the new one may have code the last one didn't
  useEffect(() => {
    const body = ref.current;
    if (!body?.querySelector(HIGHLIGHTABLE)) return;
    import("~/lib/highlight-code")
      .then(({ highlightCode }) => highlightCode(body))
      // A chunk gone after a deploy, or a grammar that throws, leaves the
      // code as it was rendered: plain and readable.
      .catch(() => {});
  }, [html]);

  // A Bluesky post reports its height once it loads; its frame page passes
  // that up (see the /embed route), and only to a frame this body created.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const height = (event.data as { goldroadEmbedHeight?: unknown } | null)
        ?.goldroadEmbedHeight;
      if (typeof height !== "number" || !Number.isFinite(height)) return;
      for (const frame of ref.current?.querySelectorAll<HTMLIFrameElement>(
        "iframe[data-embed-player]",
      ) ?? []) {
        if (frame.contentWindow === event.source)
          frame.style.height = `${Math.min(Math.max(height, 80), 4000)}px`;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="relative">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegation — the targets are links, which take Enter themselves */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same: the handler only acts on the embed links inside */}
      <div
        className="gr-prose text-[1.0625rem] leading-[1.7] wrap-anywhere"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdownToHtml escapes raw HTML and filters URLs
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={loadEmbed}
        ref={ref}
      />
      {Offer && quoteHref && <Offer prose={ref} quoteHref={quoteHref} />}
    </div>
  );
}

/**
 * Swaps a clicked embed preview for its player. A click meant for a new tab
 * or window (modifier keys, a middle click) is left to the browser, which
 * opens the original page as the link says.
 */
export function loadEmbed(event: React.MouseEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const preview = (event.target as Element | null)?.closest?.(
    "a[data-embed-frame]",
  );
  if (!(preview instanceof HTMLAnchorElement)) return;
  const src = preview.dataset.embedFrame ?? "";
  // Only our own frame pages: the attribute came from the renderer, but a
  // frame is the one thing this handler creates, so it checks.
  if (!src.startsWith("/embed/")) return;
  event.preventDefault();

  const frame = document.createElement("iframe");
  frame.src = src;
  frame.title = preview.dataset.embedTitle ?? "Embedded content";
  frame.dataset.embedPlayer = "";
  frame.allow =
    "autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write";
  frame.allowFullscreen = true;
  frame.className = "block w-full border-0 bg-ink/5";
  if (preview.dataset.embedRatio)
    frame.style.aspectRatio = preview.dataset.embedRatio;
  else frame.style.height = `${Number(preview.dataset.embedHeight) || 240}px`;
  preview.replaceWith(frame);
  // Focus follows the click: the reader's next key belongs to the player.
  frame.focus();
}
