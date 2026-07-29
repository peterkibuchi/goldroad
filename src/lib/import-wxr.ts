/**
 * WordPress WXR (WordPress eXtended RSS) export parsing — runs entirely in
 * the BROWSER via the platform DOMParser; nothing is uploaded to parse it.
 *
 * Field names verified against WordPress core's own exporter
 * (wp-admin/includes/export.php, WordPress/WordPress on GitHub): every piece
 * of content is an RSS <item> decorated with WordPress-namespaced fields —
 * wp:post_id, wp:post_type ("post" | "page" | "attachment" | a custom type),
 * wp:status ("publish" | "draft" | "future" | ...), wp:post_date, and the
 * body itself in content:encoded. Only wp:post_type = "post" is imported:
 * pages, attachments, and any custom post type are counted and skipped,
 * never silently imported as if they were posts (a WXR export of an active
 * site commonly carries far more attachments than posts).
 *
 * XML-entity safety: a stock WXR export never contains a DOCTYPE (it is a
 * plain `<?xml ...?><rss>` document with no internal/external entity
 * declarations) — so rather than trust that every engine's DOMParser caps
 * entity expansion (billion-laughs), this parser REFUSES any input
 * containing a DOCTYPE/ENTITY declaration outright, before DOMParser ever
 * sees it. That closes the entity-bomb class of attack independent of
 * runtime/parser behavior, at the cost of nothing a real export needs.
 */
import {
  detectPreview,
  guidHash,
  isoDate,
  MAX_EXPORT_POSTS,
  MAX_ITEM_CONTENT_CHARS,
} from "~/lib/import";
import { MAX_EXPORT_TEXT_BYTES } from "~/lib/import-formats";
import { MAX_TITLE_LENGTH } from "~/lib/publish";

/** Re-exported from ~/lib/import-formats — the SAME cap ~/lib/import-ghost
 * uses; both are read as text in one shot rather than streamed/inflated. */
export { guidHash, MAX_EXPORT_TEXT_BYTES as MAX_EXPORT_XML_BYTES };

export type WxrPost = {
  /** wp:post_id — stable across re-exports of the same site. */
  id: string;
  title: string;
  /** ISO timestamp from wp:post_date, or null when missing/unparseable. */
  publishedAt: string | null;
  contentHtml: string;
  /** true = wp:status is "publish"; false = any other status; null =
   * missing. */
  publishedAtSource: boolean | null;
  preview: boolean;
  /** The item's own <link> (its live permalink), when it parses as a public
   * https URL — WXR carries this directly, no host guess needed. */
  link: string | null;
};

export type ParsedWxrExport = {
  posts: WxrPost[];
  skipped: { pages: number; attachments: number; other: number };
  truncated: number;
  /** Not a readable/valid WXR document at all (bad XML, a DOCTYPE present,
   * or no rss/channel root) — the page shows its own copy for this. */
  malformed: boolean;
};

/** Ledger identity for a WXR export post — namespaced so it can never
 * collide with a feed or another format's export guid. */
export function wordpressPostGuid(id: string): string {
  return `wordpress-export:${id}`;
}

const DOCTYPE_RE = /<!(doctype|entity)\b/i;

/** First child matching `tagName` exactly (handles WordPress's own
 * "wp:field" / "content:encoded" prefixes as literal names, which is how
 * every real WXR export writes them), falling back to a namespace-agnostic
 * localName search for files re-serialized with different prefixes. */
function firstChildText(
  el: Element,
  tagName: string,
  localName: string,
): string | null {
  const direct = el.getElementsByTagName(tagName)[0];
  if (direct) return direct.textContent;
  for (const node of Array.from(el.children)) {
    if (node.localName === localName) return node.textContent;
  }
  return null;
}

/** Validates a link as a public https URL, or drops it — same bar the feed
 * path holds provenance links to (stored, later rendered as an href). */
function safePublicHttpsLink(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The whole export → picker-ready posts. Never throws: malformed XML, a
 * DOCTYPE-bearing file, or a document with no rss/channel root all resolve
 * to `malformed: true` with zero posts, which the page reports as an honest
 * "couldn't read that as a WordPress export" error.
 */
export function parseWxrExport(xmlText: string): ParsedWxrExport {
  const empty = {
    posts: [] as WxrPost[],
    skipped: { pages: 0, attachments: 0, other: 0 },
    truncated: 0,
  };
  if (DOCTYPE_RE.test(xmlText)) return { ...empty, malformed: true };

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlText, "application/xml");
  } catch {
    return { ...empty, malformed: true };
  }
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { ...empty, malformed: true };
  }

  const items = Array.from(doc.getElementsByTagName("item"));
  if (items.length === 0) {
    const hasRoot =
      doc.getElementsByTagName("rss").length > 0 ||
      doc.getElementsByTagName("channel").length > 0;
    return { ...empty, malformed: !hasRoot };
  }

  let pages = 0;
  let attachments = 0;
  let other = 0;
  const candidates: Element[] = [];
  for (const item of items) {
    const type = firstChildText(item, "wp:post_type", "post_type") ?? "post";
    if (type === "post") candidates.push(item);
    else if (type === "page") pages++;
    else if (type === "attachment") attachments++;
    else other++;
  }
  const truncated = Math.max(0, candidates.length - MAX_EXPORT_POSTS);

  const posts: WxrPost[] = [];
  for (const item of candidates.slice(0, MAX_EXPORT_POSTS)) {
    const id = firstChildText(item, "wp:post_id", "post_id");
    // No id = nothing stable to dedupe by; skip honestly.
    if (!id) continue;
    const html = firstChildText(item, "content:encoded", "encoded") ?? "";
    const title =
      (firstChildText(item, "title", "title") ?? "")
        .trim()
        .slice(0, MAX_TITLE_LENGTH) || "(untitled)";
    const status = firstChildText(item, "wp:status", "status");
    const capped = html.slice(0, MAX_ITEM_CONTENT_CHARS);
    posts.push({
      id,
      title,
      publishedAt: isoDate(firstChildText(item, "wp:post_date", "post_date")),
      contentHtml: capped,
      publishedAtSource: status === null ? null : status === "publish",
      preview: capped.length < html.length || detectPreview(capped, null),
      link: safePublicHttpsLink(firstChildText(item, "link", "link")),
    });
  }

  posts.sort((a, b) => {
    const at = a.publishedAt
      ? Date.parse(a.publishedAt)
      : Number.NEGATIVE_INFINITY;
    const bt = b.publishedAt
      ? Date.parse(b.publishedAt)
      : Number.NEGATIVE_INFINITY;
    return bt - at;
  });

  return {
    posts,
    skipped: { pages, attachments, other },
    truncated,
    malformed: false,
  };
}
