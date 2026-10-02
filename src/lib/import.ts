/**
 * Feed import — the pure logic behind /api/import (one-time RSS import →
 * drafts). Pure module: no `cloudflare:workers` import, fetch is injectable,
 * so every piece unit-tests without a worker.
 *
 * Trust posture: the feed URL is writer-supplied, so every network touch is
 * SSRF-guarded (assertPublicHttpsUrl + our own hostnames refused), redirects
 * are followed MANUALLY with each hop re-validated (workerd's fetch follows
 * redirects by default, which would let a public host bounce us anywhere),
 * and response bodies are stream-counted against a hard byte cap — a
 * Content-Length header is never trusted.
 *
 * Parser: htmlparser2's parseDocument in xmlMode, with our own RSS/Atom item
 * mapping. NOT parseFeed(): its item mapping reads only <description> and
 * silently drops <content:encoded> — the full-HTML payload that is the whole
 * point of importing (verified against live Substack feeds). htmlparser2
 * performs no DTD/custom-entity expansion, so entity-bomb XML ("billion
 * laughs") stays inert text; the pre-parse byte cap bounds everything else.
 */
import { DomUtils, parseDocument } from "htmlparser2";

import { assertPublicHttpsUrl } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { CANONICAL_ORIGIN, LEGACY_ORIGINS } from "~/lib/origin";
import { MAX_TITLE_LENGTH } from "~/lib/publish";

type Element = ReturnType<typeof parseDocument>["children"][number] & {
  name?: string;
  attribs?: Record<string, string>;
};

/** Hard cap on a fetched feed/page body — streamed, never trusted from
 * Content-Length. A 20-item Substack feed measures well under 1 MB. */
export const MAX_FEED_BYTES = 2 * 1024 * 1024;

/** Redirect hops we follow (each hop re-validated). Substack custom domains
 * typically need one (apex → www); more than three smells like a trap. */
export const MAX_REDIRECT_HOPS = 3;

/** Wall-clock bound per fetch — a slow-loris feed host must not pin the
 * request open. */
export const FEED_FETCH_TIMEOUT_MS = 10_000;

/** Items returned per run. Substack feeds carry 20; deeper archives are the
 * export-file import's job (~/lib/import-zip), said honestly in the UI. */
export const MAX_ITEMS_PER_RUN = 20;

/** Posts surfaced per export upload (and the hash-count ceiling
 * /api/import/status accepts). Lives HERE, not in ~/lib/import-zip: the
 * status route needs the number, and importing the zip module server-side
 * would drag fflate into the worker bundle. */
export const MAX_EXPORT_POSTS = 1000;

/** Per-item HTML cap before it goes back to the browser for conversion —
 * bounds the response size independently of the whole-feed cap. */
export const MAX_ITEM_CONTENT_CHARS = 300_000;

/** Feed-fetch runs per writer per hour. Session-gated endpoint, so this
 * bounds what one authenticated account can spend, not anonymous traffic. */
export const MAX_IMPORTS_PER_HOUR = 6;

/** Feed URLs longer than this are refused before any parsing. */
export const MAX_IMPORT_URL_LENGTH = 2048;

/** Extra feed locations tried when the pasted URL answers with HTML. */
export const MAX_DISCOVERY_ATTEMPTS = 3;

export type ImportErrorCode =
  | "invalid_url"
  | "own_host"
  | "too_many_redirects"
  | "fetch_failed"
  /** The host answered 429 — it is refusing OUR requests, not down. Substack
   * does this to all Cloudflare-Workers egress (verified in production;
   * user-agent changes don't help), so the UI can point at the export-upload
   * path instead of telling the writer to retry something that never works. */
  | "upstream_blocked"
  | "feed_too_large"
  | "not_a_feed";

export class ImportError extends Error {
  code: ImportErrorCode;
  constructor(code: ImportErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const OWN_HOSTNAMES = [CANONICAL_ORIGIN, ...LEGACY_ORIGINS].map((o) =>
  new URL(o).hostname.toLowerCase(),
);

/** Our own zone: the apex AND anything under it. Subdomain-inclusive on
 * purpose — a same-zone fetch target is the thing being refused, and our zone
 * has more names in it than the apex (previews, future subdomains, anything a
 * CNAME picks up). `endsWith("." + own)` only ever matches a true label
 * boundary, so `nottrygoldroad.com` is still someone else's host. */
function isOwnHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return OWN_HOSTNAMES.some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * SSRF guard for writer-supplied feed URLs: everything assertPublicHttpsUrl
 * enforces (https-only, no ports/userinfo/IP-literals/single-label hosts),
 * plus a refusal of our own zone — importing Goldroad into Goldroad is
 * never meant, and a same-zone fetch is exactly the request-loop/front-door
 * class the `global_fetch_strictly_public` compatibility flag also closes at
 * the platform level (defense in depth: both layers refuse it).
 */
export function assertImportableUrl(urlString: string): URL {
  if (urlString.length > MAX_IMPORT_URL_LENGTH)
    throw new ImportError("invalid_url", "URL too long");
  let url: URL;
  try {
    url = assertPublicHttpsUrl(urlString);
  } catch {
    throw new ImportError("invalid_url", `not a public https URL`);
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".workers.dev") || isOwnHostname(host))
    throw new ImportError("own_host", "refusing to import from this app");
  return url;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetches a writer-supplied URL with manual redirect handling: every hop's
 * Location is re-validated through assertImportableUrl before it is followed
 * (the 307/308-to-internal-host bypass dies here), at most
 * MAX_REDIRECT_HOPS hops, each fetch bounded by FEED_FETCH_TIMEOUT_MS.
 * Returns the final response plus the URL that actually answered.
 */
export async function fetchImportable(
  urlString: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ res: Response; finalUrl: URL }> {
  let url = assertImportableUrl(urlString);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
        headers: {
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8",
        },
      });
    } catch {
      throw new ImportError("fetch_failed", `could not reach ${url.hostname}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      // Drain nothing: redirect bodies are irrelevant; cancel defensively.
      await res.body?.cancel().catch(() => {});
      if (!location)
        throw new ImportError("fetch_failed", "redirect without location");
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        throw new ImportError("invalid_url", "unparseable redirect target");
      }
      url = assertImportableUrl(next); // re-validate EVERY hop
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new ImportError("too_many_redirects");
}

/** Reads a response body as text under the streaming byte cap; throws
 * feed_too_large the moment the cap is crossed. */
export async function readFeedBody(res: Response): Promise<string> {
  const bytes = await readBodyCapped(res, MAX_FEED_BYTES);
  if (bytes === null) throw new ImportError("feed_too_large");
  return new TextDecoder().decode(bytes);
}

/** One INBOUND feed item (importing someone's archive) — distinct from
 * ~/lib/feed's FeedItem, which is our OUTBOUND rss.xml serialization shape. */
export type ImportFeedItem = {
  /** guid/atom id, falling back to the item link — the dedupe identity. */
  guid: string;
  /** The item's public URL (validated https), or null. */
  link: string | null;
  title: string;
  /** ISO timestamp, or null when the feed's date is missing/unparseable. */
  publishedAt: string | null;
  /** The item's HTML (content:encoded / atom content / summary /
   * description), capped at MAX_ITEM_CONTENT_CHARS. */
  contentHtml: string;
  /** Truncation heuristic verdict — teaser-length content or a trailing
   * "read more" link back to the item's own URL. Previews are honest:
   * unchecked by default in the picker, never silently imported as if
   * complete. */
  preview: boolean;
};

export type ParsedFeed = {
  title: string;
  items: ImportFeedItem[];
  /** Items the feed carried before the MAX_ITEMS_PER_RUN cut. */
  totalItems: number;
};

function childText(name: string, scope: Element): string | null {
  const el = DomUtils.getElementsByTagName(name, scope, true)[0];
  return el ? DomUtils.textContent(el) : null;
}

/** Atom <link> carries its URL in href; RSS <link> carries it as text. */
function itemLink(scope: Element): string | null {
  for (const el of DomUtils.getElementsByTagName("link", scope, true)) {
    const attribs = (el as Element).attribs ?? {};
    // Atom: prefer rel="alternate" (or no rel); ignore self/edit links.
    if (attribs.href) {
      if (!attribs.rel || attribs.rel === "alternate") return attribs.href;
      continue;
    }
    const text = DomUtils.textContent(el).trim();
    if (text) return text;
  }
  return null;
}

/** A link is only stored/rendered when it validates as a public https URL —
 * feed-supplied hrefs otherwise reach provenance lines on reader pages. */
function safeLink(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return assertImportableUrl(raw.trim()).href;
  } catch {
    return null;
  }
}

/** Lenient date-string → ISO timestamp, or null when unparseable. Shared with
 * the export-zip parser (~/lib/import-zip), which reads Substack CSV dates. */
export function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Newest first, undated last — the order every import picker presents, so it
 * reads like the feed path and the dashboard: recent work on top.
 *
 * Undated posts sort with `-Infinity` rather than 0 so they park at the end
 * instead of claiming 1970 — and an unparseable date counts as undated, since
 * `Date.parse` answers NaN there and NaN would poison the subtraction. Two
 * undated posts compare equal, so a format with a tiebreaker of its own (the
 * Substack path's numeric post id) gets a real 0 to chain from rather than a
 * NaN that `Array.prototype.sort` silently swallows.
 */
export function comparePublishedAtDesc(
  a: { publishedAt: string | null },
  b: { publishedAt: string | null },
): number {
  const at = epochOrUndated(a.publishedAt);
  const bt = epochOrUndated(b.publishedAt);
  return at === bt ? 0 : bt - at;
}

function epochOrUndated(raw: string | null): number {
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** Tail window scanned for a trailing self-link ("Read more"). */
const PREVIEW_TAIL_CHARS = 400;
/** Text shorter than this (tags stripped) reads as a teaser, not a post. */
const PREVIEW_TEXT_CHARS = 500;

/** Compare URLs ignoring scheme-noise: host + path, no query/hash, no
 * trailing slash. Heuristic-grade on purpose. */
function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The truncated-item heuristic. Paywalled/gated posts appear in feeds as
 * normal-looking items holding a teaser — there is no reliable
 * machine-readable marker — so this flags: (a) content whose text is
 * teaser-short, or (b) content ending in a link back to the item's own URL
 * (Substack's "Read more" pattern). A miss costs the writer one checkbox
 * click, never a silent partial import.
 */
export function detectPreview(
  contentHtml: string,
  link: string | null,
): boolean {
  const text = contentHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < PREVIEW_TEXT_CHARS) return true;
  if (link) {
    const own = urlKey(link);
    const tail = contentHtml.slice(-PREVIEW_TAIL_CHARS);
    for (const match of tail.matchAll(
      /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    )) {
      const href = match[1] ?? match[2];
      if (own && href && urlKey(href) === own) return true;
    }
  }
  return false;
}

/**
 * Parses an RSS or Atom document into the picker's item list, or null when
 * the text isn't a feed. Names are matched as feeds actually write them
 * (xmlMode is case-sensitive: `pubDate`, `content:encoded`).
 */
export function parseFeedDocument(xml: string): ParsedFeed | null {
  const doc = parseDocument(xml, { xmlMode: true });
  const rssItems = DomUtils.getElementsByTagName("item", doc, true);
  const atomEntries =
    rssItems.length > 0
      ? []
      : DomUtils.getElementsByTagName("entry", doc, true);
  const isRss = rssItems.length > 0;
  const raw = isRss ? rssItems : atomEntries;

  // The first <title> in document order is the feed's own (it precedes any
  // item/entry titles in every real feed).
  const feedTitle = (childText("title", doc as unknown as Element) ?? "")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);

  if (raw.length === 0) {
    // A feed with zero items is still a feed — tell "empty feed" apart from
    // "not XML at all" by looking for the root elements.
    const hasFeedRoot =
      DomUtils.getElementsByTagName("rss", doc, true).length > 0 ||
      DomUtils.getElementsByTagName("feed", doc, true).length > 0 ||
      DomUtils.getElementsByTagName("channel", doc, true).length > 0;
    return hasFeedRoot ? { title: feedTitle, items: [], totalItems: 0 } : null;
  }

  const items: ImportFeedItem[] = [];
  for (const el of raw.slice(0, MAX_ITEMS_PER_RUN)) {
    const scope = el as Element;
    const link = safeLink(itemLink(scope));
    const guid =
      (isRss ? childText("guid", scope) : childText("id", scope))?.trim() ||
      link ||
      "";
    // No guid and no link = nothing to dedupe or attribute by; skip honestly
    // (the picker count states what was found, not what the feed claimed).
    if (!guid) continue;
    const contentRaw =
      (isRss
        ? childText("content:encoded", scope)
        : (childText("content", scope) ?? childText("summary", scope))) ??
      childText("description", scope) ??
      "";
    const capped = contentRaw.slice(0, MAX_ITEM_CONTENT_CHARS);
    items.push({
      guid,
      link,
      title: (childText("title", scope) ?? "")
        .trim()
        .slice(0, MAX_TITLE_LENGTH),
      publishedAt: isoDate(
        isRss
          ? childText("pubDate", scope)
          : (childText("published", scope) ?? childText("updated", scope)),
      ),
      contentHtml: capped,
      // A cap-truncated item is by definition incomplete — flag it.
      preview: capped.length < contentRaw.length || detectPreview(capped, link),
    });
  }
  return { title: feedTitle, items, totalItems: raw.length };
}

/** Cheap "did we get an HTML page instead of a feed" sniff, for deciding
 * whether autodiscovery is worth attempting. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 1024).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.includes("<html");
}

/**
 * Feed autodiscovery on an HTML answer: `<link rel="alternate">` feed hints
 * from the page head, then the conventional locations (`/feed`, `/rss/`) on
 * the page's origin — Substack, WordPress, and Ghost between them. Returns
 * validated candidate URLs, deduped, capped at MAX_DISCOVERY_ATTEMPTS.
 */
export function discoverFeedUrls(html: string, base: URL): string[] {
  const candidates: string[] = [];
  const doc = parseDocument(html); // HTML mode — this IS an HTML page
  for (const el of DomUtils.getElementsByTagName("link", doc, true)) {
    const attribs = (el as Element).attribs ?? {};
    const rel = attribs.rel?.toLowerCase() ?? "";
    const type = attribs.type?.toLowerCase() ?? "";
    if (rel !== "alternate") continue;
    if (!type.includes("rss") && !type.includes("atom")) continue;
    if (!attribs.href) continue;
    try {
      candidates.push(new URL(attribs.href, base).href);
    } catch {
      // unparseable hint — skip
    }
  }
  const path = base.pathname.replace(/\/+$/, "");
  candidates.push(
    `${base.origin}${path}/feed`,
    `${base.origin}/feed`,
    `${base.origin}/rss/`,
  );
  const out: string[] = [];
  for (const candidate of candidates) {
    if (out.length >= MAX_DISCOVERY_ATTEMPTS) break;
    if (candidate === base.href || out.includes(candidate)) continue;
    try {
      out.push(assertImportableUrl(candidate).href);
    } catch {
      // a hint pointing somewhere we refuse to fetch is just dropped
    }
  }
  return out;
}

/** SHA-256 hex of a feed item's guid — the ledger's fixed-width dedupe key
 * (guids are arbitrary feed-supplied strings, sometimes very long URLs). */
export async function guidHash(guid: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(guid),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * First markdown image URL in a body — the publish-time cover candidate for
 * imported posts. Only public https URLs qualify (the fetch that follows is
 * SSRF-guarded again regardless). Pattern hardening matches ~/lib/feed's
 * stripMarkdown: `[` excluded from the text class and `(`/`)` from the URL
 * class, so bracket floods fail fast instead of scanning to the end.
 */
export function extractFirstImageUrl(markdown: string): string | null {
  return extractImageUrls(markdown)[0] ?? null;
}

/**
 * Publish-time image fetch for imported posts — used for the cover and for
 * every rehosted body image. Pulled server-side under the same SSRF regime as
 * the feed itself (hop-validated, stream-capped at the lexicon's 1 MB blob
 * limit) and the raster-only MIME allowlist. Returns null on ANY miss — an
 * imported post missing a picture is fine; a failed publish over one is not.
 * No downscaling here: workerd has no canvas/image API on the free tier, so
 * an over-1MB original is skipped rather than shrunk.
 */
export async function fetchImportableImage(
  url: string,
  maxBytes: number,
  isAllowedMime: (mime: string | null) => boolean,
  fetchImpl: FetchLike = fetch,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string } | null> {
  try {
    const { res } = await fetchImportable(url, fetchImpl);
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!isAllowedMime(mime)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readBodyCapped(res, maxBytes);
    if (bytes === null) return null;
    return { bytes, mime };
  } catch {
    return null;
  }
}

/**
 * Markdown images in a body. Shared by the extractors below so the cover
 * candidate and the rehost list can never disagree about what an image is.
 *
 * THE ALT CLASS HAS TO TOLERATE ESCAPES. Alt text is the writer's own words, so
 * anything producing this markdown escapes the markdown-significant characters
 * in it — brackets included, as `\[` and `\]`. The class used to be
 * `[^[\]]*`, which excludes the literal `[` an escape leaves behind, so an alt
 * like "chart \[2026\]" failed to match and the whole image line went
 * unrecognised: not rehosted at publish, not a cover candidate. The image kept
 * pointing at somebody else's CDN, and the only clue was a square bracket in a
 * description.
 *
 * So an alt is now any run of escaped-anything (`\\.`) or ordinary
 * non-bracket, non-backslash characters. Unescaped brackets are still excluded,
 * which is what keeps this from running past the end of one image and swallowing
 * the next.
 */
const MARKDOWN_IMAGE_RE = /!\[(?:\\.|[^[\]\\])*\]\(\s*([^()\s]+)[^()]*\)/g;

/**
 * How many body images one publish will rehost. A bound on the fetches and
 * blob writes a single publish can trigger; beyond it the remaining images
 * keep pointing at the source, which is exactly what they did before.
 */
export const MAX_REHOSTED_IMAGES = 20;

/**
 * Distinct public-https image URLs in a body, in first-appearance order.
 * Everything else — a relative path, an already-rehosted `/img/…` proxy path,
 * an IP literal, a non-https scheme — is dropped by safeLink, which is
 * assertImportableUrl: the SSRF regime, applied at extraction as well as at
 * fetch.
 */
export function extractImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const url = safeLink(match[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Uploads fetched bytes as a blob in the writer's repo; null on any failure.
 * Injected so the rehost is testable without a PDS. */
export type BlobUpload = (
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
) => Promise<unknown | null>;

export type RehostResult = {
  /** The body with every rehosted image repointed at the proxy path. */
  body: string;
  /** The blobs written, in body order — the record MUST reference these or
   * the PDS never serves them (see DocumentRecord in ~/lib/publish). */
  blobs: unknown[];
  /** Images left pointing at the source (fetch refused, too big, wrong type,
   * or past the cap). Not an error — just not rehosted. */
  skipped: number;
};

/**
 * Copies an imported post's body images into the writer's own repo, at
 * publish time, for that one post.
 *
 * Why at publish and not at import: this spends the writer's repo quota, so
 * it happens for a post they decided to keep, not for every item a feed
 * scrape turned up. Why at all: an imported body points at the source's CDN,
 * which is exactly the copy that disappears when the writer leaves the
 * platform the post came from — rehosting is what makes the archive theirs.
 *
 * Every fetch goes through fetchImportableImage, so the feed's SSRF regime
 * (public https only, every redirect hop re-validated, raster MIME
 * allowlist, 1 MB stream cap) governs it — writer-supplied URLs are not
 * trusted here just because they arrived through an import.
 *
 * Best-effort per image: one that can't be fetched keeps its original URL and
 * the publish carries on. A post publishing with some images still remote
 * beats a publish that fails over a picture.
 */
export async function rehostBodyImages(opts: {
  body: string;
  did: string;
  upload: BlobUpload;
  maxBytes: number;
  isAllowedMime: (mime: string | null) => boolean;
  /** The proxy path a rehosted blob is served from (~/lib/blob's
   * blobImagePath) — injected to keep this module free of blob.ts's
   * route-shape concerns. */
  imagePath: (did: string, cid: string) => string;
  fetchImpl?: FetchLike;
}): Promise<RehostResult> {
  const urls = extractImageUrls(opts.body);
  if (urls.length === 0) return { body: opts.body, blobs: [], skipped: 0 };

  const replacements = new Map<string, string>();
  const blobs: unknown[] = [];
  let skipped = Math.max(0, urls.length - MAX_REHOSTED_IMAGES);

  for (const url of urls.slice(0, MAX_REHOSTED_IMAGES)) {
    const candidate = await fetchImportableImage(
      url,
      opts.maxBytes,
      opts.isAllowedMime,
      opts.fetchImpl,
    );
    if (!candidate) {
      skipped += 1;
      continue;
    }
    const blob = await opts.upload(candidate.bytes, candidate.mime);
    // A CID we can't build a servable path from is a skip, not a rewrite to
    // a URL that would 404 — the original at least still renders.
    const cid =
      typeof blob === "object" &&
      blob !== null &&
      typeof (blob as { ref?: { $link?: unknown } }).ref?.$link === "string"
        ? (blob as { ref: { $link: string } }).ref.$link
        : null;
    if (!cid) {
      skipped += 1;
      continue;
    }
    replacements.set(url, opts.imagePath(opts.did, cid));
    blobs.push(blob);
  }
  if (replacements.size === 0) return { body: opts.body, blobs, skipped };

  // Rewritten through the same image pattern that found them, so a bare URL
  // appearing in prose or a link href is never touched.
  const body = opts.body.replace(MARKDOWN_IMAGE_RE, (whole, raw: string) => {
    const next = replacements.get(safeLink(raw) ?? "");
    return next ? whole.replace(raw, next) : whole;
  });
  return { body, blobs, skipped };
}

/**
 * Clamps a writer/feed-supplied original date into something a backdated TID
 * can honestly encode: never in the future (a future-dated TID would sort
 * ahead of real posts forever), never before the epoch (TIDs are unsigned).
 * Null when the input is missing or unparseable — the publish then uses now.
 */
export function clampOriginalDate(
  value: Date | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  if (value.getTime() > now.getTime()) return now;
  if (value.getTime() < 86_400_000) return null; // pre-epoch garbage
  return value;
}
