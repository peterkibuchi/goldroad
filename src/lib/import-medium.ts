/**
 * Medium export-zip parsing — runs entirely in the BROWSER (fflate, same as
 * ~/lib/import-zip's Substack path); the zip never leaves the writer's
 * machine. Medium's own docs (help.medium.com "Export your account data")
 * describe only the top-level layout — a `posts/` folder of `.html` files —
 * and do not document filename conventions or per-file HTML structure. Like
 * the Ghost/WXR parsers, this one reads DEFENSIVELY: every classification
 * below is a best-effort heuristic, documented at the point it's applied,
 * and every heuristic MISS keeps the item as an ordinary post rather than
 * silently excluding it — the one failure mode this whole pipeline never
 * allows (see ~/lib/import-zip's own header for the same rule on Substack).
 *
 *   posts/<slug>-<hex id>.html          — a published post. Observed shape:
 *                                         an optional `YYYY-MM-DD_` date
 *                                         prefix, a slugified title, then a
 *                                         12-hex-digit Medium post id.
 *   posts/draft_<slug>-<hex id>.html    — a draft. The `draft_` prefix is
 *                                         the one Medium filename convention
 *                                         that is unambiguous.
 *
 * Responses/comments left on OTHER people's posts land in the same
 * `posts/` folder with no documented filename marker. This parser only
 * excludes a file as a response when its OWN content confirms it: every
 * Medium-exported post/response HTML carries a `<link rel="canonical">`
 * pointing at its Medium URL, whose trailing `-<hex id>` should match the
 * file's own id for a post that's really yours. A mismatch (canonical
 * points at a different id — i.e. someone else's story) is the only signal
 * this treats as "exclude"; anything else (no canonical tag, a parse
 * failure, a same-id canonical) keeps the item as a normal post.
 *
 * Zip-bomb defenses (entry-count ceiling before any inflation, per-entry
 * size cap checked before AND after inflation, whole-run inflated-byte
 * budget) are the SAME ones the Substack path uses — shared via
 * ~/lib/zip-safety so there is exactly one implementation of this defense
 * to keep correct.
 */
import { detectPreview, guidHash, MAX_EXPORT_POSTS } from "~/lib/import";
import { MAX_EXPORT_ZIP_BYTES } from "~/lib/import-formats";
import {
  MAX_ENTRY_BYTES,
  MAX_TOTAL_INFLATED_BYTES,
  MAX_ZIP_ENTRIES,
} from "~/lib/import-zip";
import { MAX_TITLE_LENGTH } from "~/lib/publish";
import {
  createBudgetedInflater,
  EntryTooLargeError,
  ExportTooComplexError,
  listZipEntries,
} from "~/lib/zip-safety";

/** Re-exported from ~/lib/import-formats — the SAME cap ~/lib/import-zip
 * uses, checked there before any parser module is even imported. */
export {
  ExportTooComplexError,
  guidHash,
  MAX_EXPORT_ZIP_BYTES as MAX_MEDIUM_ZIP_BYTES,
};

export type MediumPostFailure = {
  name: string;
  reason: "corrupt" | "too_large";
};

export type MediumPost = {
  /** Filename minus its ".html" extension — the stable identity a
   * re-exported archive keeps, so it seeds the ledger guid. */
  fileSlug: string;
  title: string;
  /** ISO timestamp parsed from the filename's date prefix, or null (drafts,
   * and any file without one). */
  publishedAt: string | null;
  contentHtml: string;
  /** false = the `draft_` filename prefix says this never published; true =
   * a date-prefixed filename; null = neither signal present. */
  publishedAtSource: boolean | null;
  preview: boolean;
  /** The post's own `<link rel="canonical">`, when present and a public
   * https URL — Medium stamps every exported post with this, so (unlike
   * Ghost) no host input is needed for provenance. Null when absent or
   * unparseable, said plainly in the UI. */
  link: string | null;
};

export type ParsedMediumExport = {
  posts: MediumPost[];
  failures: MediumPostFailure[];
  /** Files excluded as responses/comments on someone else's post (see the
   * module header) — counted and reported honestly, never silently merged
   * into the writer's own archive. */
  skippedResponses: number;
  /** Posts found beyond MAX_EXPORT_POSTS, in the archive's own order. */
  truncated: number;
};

/** Ledger identity for a Medium export post — namespaced so it can never
 * collide with a feed or another format's export guid. */
export function mediumPostGuid(fileSlug: string): string {
  return `medium-export:${fileSlug}`;
}

/** posts/<name>.html, at the root or one archive-folder deep (mirrors the
 * same allowance ~/lib/import-zip makes for re-zipped exports). macOS
 * resource-fork noise is not a post. */
const POST_ENTRY_RE = /(?:^|\/)posts\/([^/]+)\.html$/i;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})_/;
const DRAFT_PREFIX_RE = /^draft_/i;
const HEX_ID_RE = /-([0-9a-f]{12})$/i;

function isMediumPostEntry(name: string): boolean {
  if (name.includes("__MACOSX/")) return false;
  const match = POST_ENTRY_RE.exec(name);
  return match !== null && !match[1].startsWith(".");
}

function fileSlugOf(name: string): string {
  const match = POST_ENTRY_RE.exec(name);
  return match ? match[1] : name;
}

/** "2024-01-02_my-post-title-a1b2c3d4e5f6" → "My post title" — the honest
 * fallback title when the HTML carries no <title>. */
function titleFromFileSlug(fileSlug: string): string {
  const words = fileSlug
    .replace(DRAFT_PREFIX_RE, "")
    .replace(DATE_PREFIX_RE, "")
    .replace(HEX_ID_RE, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (words === "") return "(untitled)";
  return (words[0].toUpperCase() + words.slice(1)).slice(0, MAX_TITLE_LENGTH);
}

function extractTitle(html: string, fileSlug: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.trim();
  return (raw && raw.length > 0 ? raw : titleFromFileSlug(fileSlug)).slice(
    0,
    MAX_TITLE_LENGTH,
  );
}

function extractDate(fileSlug: string): string | null {
  const match = DATE_PREFIX_RE.exec(fileSlug);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The post's own `<link rel="canonical">`, parsed, or null when absent or
 * unparseable. Shared by the response heuristic and the provenance link. */
function extractCanonicalUrl(html: string): URL | null {
  const match =
    /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Best-effort response detector — see the module header for the full
 * rationale. Only ever narrows (excludes) on a specific positive signal:
 * a medium.com canonical link whose trailing hex id does NOT match the
 * file's own id (i.e. it canonically belongs to someone else's story). */
function looksLikeResponse(canonical: URL | null, fileSlug: string): boolean {
  if (!canonical || !/(^|\.)medium\.com$/i.test(canonical.hostname)) {
    return false;
  }
  const canonicalSegment = canonical.pathname.split("/").at(-1) ?? "";
  const ownSlug = fileSlug
    .replace(DRAFT_PREFIX_RE, "")
    .replace(DATE_PREFIX_RE, "");
  const canonicalId = HEX_ID_RE.exec(canonicalSegment)?.[1];
  const ownId = HEX_ID_RE.exec(ownSlug)?.[1];
  // Both ids must be readable to compare — an inconclusive read never
  // excludes.
  if (!canonicalId || !ownId) return false;
  return canonicalId.toLowerCase() !== ownId.toLowerCase();
}

/**
 * The whole export → picker-ready posts. Throws only when the bytes aren't
 * a readable zip at all, or carry more entries than a posts export
 * plausibly would (ExportTooComplexError — refused BEFORE any inflation).
 * Everything past those two gates degrades per-item: entries are inflated
 * ONE AT A TIME so a single corrupt stream (or an oversize claim) costs
 * that post alone, never the archive.
 */
export function parseMediumExport(bytes: Uint8Array): ParsedMediumExport {
  const entryNames = listZipEntries(bytes);
  if (entryNames.length > MAX_ZIP_ENTRIES) throw new ExportTooComplexError();

  const decoder = new TextDecoder();
  const inflate = createBudgetedInflater(bytes, MAX_TOTAL_INFLATED_BYTES);

  // Candidates first (names only, no inflation) — the archive cap applies
  // HERE, before any per-entry work, so posts past it cost nothing but the
  // count reported honestly as `truncated`.
  const candidates = entryNames.filter(isMediumPostEntry);
  const truncated = Math.max(0, candidates.length - MAX_EXPORT_POSTS);

  const failures: MediumPostFailure[] = [];
  const posts: MediumPost[] = [];
  let skippedResponses = 0;

  for (const name of candidates.slice(0, MAX_EXPORT_POSTS)) {
    let html: string;
    try {
      html = decoder.decode(inflate(name, MAX_ENTRY_BYTES));
    } catch (err) {
      failures.push({
        name,
        reason: err instanceof EntryTooLargeError ? "too_large" : "corrupt",
      });
      continue;
    }
    const fileSlug = fileSlugOf(name);
    const canonical = extractCanonicalUrl(html);
    if (looksLikeResponse(canonical, fileSlug)) {
      skippedResponses++;
      continue;
    }
    const isDraft = DRAFT_PREFIX_RE.test(fileSlug);
    const publishedAt = extractDate(fileSlug);
    posts.push({
      fileSlug,
      title: extractTitle(html, fileSlug),
      publishedAt,
      contentHtml: html,
      publishedAtSource: isDraft ? false : publishedAt !== null ? true : null,
      preview: detectPreview(html, null),
      link: canonical?.href ?? null,
    });
  }

  // Newest first, matching the Substack and feed pickers.
  posts.sort((a, b) => {
    const at = a.publishedAt
      ? Date.parse(a.publishedAt)
      : Number.NEGATIVE_INFINITY;
    const bt = b.publishedAt
      ? Date.parse(b.publishedAt)
      : Number.NEGATIVE_INFINITY;
    return bt - at;
  });

  return { posts, failures, skippedResponses, truncated };
}
