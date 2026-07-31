/**
 * Ghost content-export JSON parsing — runs entirely in the BROWSER
 * (JSON.parse only, no dependency). Ghost's own docs (Settings → Advanced →
 * Import/export → "Export", ghost.org/help/exports) describe only the menu
 * path and say the file carries "posts, pages, tags, settings" — Ghost does
 * not publicly document the JSON's field-level schema. This parser therefore
 * reads DEFENSIVELY, the same posture as ~/lib/import-wxr and
 * ~/lib/import-medium:
 *
 *  - Shape: a full Ghost export nests posts at `db[0].data.posts` (the shape
 *    every Ghost version has shipped in practice); a bare `data.posts` or a
 *    top-level `posts` array is also accepted, for hand-trimmed or
 *    partial-export files. Anything else yields zero posts, surfaced by the
 *    page as an honest "couldn't find any posts" error, not a crash.
 *  - Type filter: only `type: "post"` is imported; `"page"` entries are
 *    counted and skipped, never silently imported as posts.
 *  - Lexical-only posts: a post whose `html` is present is used as-is
 *    (Ghost keeps `html` in sync with the editor content in the normal case);
 *    a post with NO usable `html` (empty or missing — e.g. a Lexical-only
 *    post from an export flavor that omits the rendered mirror) surfaces as
 *    a per-item failure rather than importing blank content. Converting
 *    Lexical's own node graph is out of scope: BlockNote's importer (the
 *    conversion step downstream) speaks HTML, not Ghost's Lexical dialect.
 */
import {
  comparePublishedAtDesc,
  detectPreview,
  guidHash,
  isoDate,
  MAX_EXPORT_POSTS,
  MAX_ITEM_CONTENT_CHARS,
} from "~/lib/import";
import { MAX_EXPORT_TEXT_BYTES, normalizeHost } from "~/lib/import-formats";
import { MAX_TITLE_LENGTH } from "~/lib/publish";

/** Re-exported from ~/lib/import-formats — the SAME cap ~/lib/import-wxr
 * uses, and the SAME hostname normalizer ~/lib/import-zip uses (both take an
 * optional publication address for provenance-link reconstruction). */
export {
  guidHash,
  MAX_EXPORT_TEXT_BYTES as MAX_EXPORT_JSON_BYTES,
  normalizeHost,
};

export type GhostPostFailure = { id: string; reason: "no_html" };

export type GhostPost = {
  /** Ghost's own post id (or uuid, when id is absent) — the stable identity
   * a re-exported site keeps, so it seeds the ledger guid. */
  id: string;
  slug: string;
  title: string;
  /** ISO timestamp from `published_at`, or null (draft / missing). */
  publishedAt: string | null;
  contentHtml: string;
  /** false = `status` says draft/scheduled; null = status missing/unknown. */
  publishedAtSource: boolean | null;
  preview: boolean;
};

export type ParsedGhostExport = {
  posts: GhostPost[];
  failures: GhostPostFailure[];
  /** Non-post entries (type: "page", or any other type) — counted, never
   * imported as posts. */
  skippedPages: number;
  /** Posts found beyond MAX_EXPORT_POSTS, in the export's own order. */
  truncated: number;
};

/** Ledger identity for a Ghost export post — namespaced so it can never
 * collide with a feed or another format's export guid. */
export function ghostPostGuid(id: string): string {
  return `ghost-export:${id}`;
}

/** The post's public URL, reconstructed Ghost-style (`https://host/slug/`)
 * from a writer-confirmed host — Ghost's raw export carries no absolute URL
 * of its own. Null host or an unsafe slug = no provenance, said plainly. */
export function constructGhostSourceUrl(
  host: string | null,
  slug: string,
): string | null {
  if (!host || slug === "") return null;
  if (!/^[a-zA-Z0-9._~-]+$/.test(slug)) return null;
  return `https://${host}/${slug}/`;
}

type RawGhostPost = {
  id?: unknown;
  uuid?: unknown;
  slug?: unknown;
  title?: unknown;
  html?: unknown;
  status?: unknown;
  type?: unknown;
  published_at?: unknown;
};

/** Digs out the posts array from any of the shapes a Ghost export (or a
 * hand-trimmed slice of one) plausibly carries. Never throws — an
 * unrecognized shape just yields no posts, handled the same as "empty
 * export" by the caller. */
function extractRawPosts(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const db = obj.db;
  if (
    Array.isArray(db) &&
    db.length > 0 &&
    db[0] &&
    typeof db[0] === "object"
  ) {
    const data = (db[0] as Record<string, unknown>).data;
    if (data && typeof data === "object") {
      const posts = (data as Record<string, unknown>).posts;
      if (Array.isArray(posts)) return posts;
    }
  }
  const data = obj.data;
  if (data && typeof data === "object") {
    const posts = (data as Record<string, unknown>).posts;
    if (Array.isArray(posts)) return posts;
  }
  if (Array.isArray(obj.posts)) return obj.posts;
  return [];
}

/**
 * The whole export → picker-ready posts. Never throws on malformed JSON or
 * an unrecognized shape — both degrade to zero posts, which the page reports
 * as an honest "couldn't find any posts in that file" error, exactly like
 * the Substack zip path's `not_an_export`.
 */
export function parseGhostExport(text: string): ParsedGhostExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { posts: [], failures: [], skippedPages: 0, truncated: 0 };
  }

  const raw = extractRawPosts(parsed);
  const truncated = Math.max(0, raw.length - MAX_EXPORT_POSTS);

  const failures: GhostPostFailure[] = [];
  const posts: GhostPost[] = [];
  let skippedPages = 0;

  for (const item of raw.slice(0, MAX_EXPORT_POSTS)) {
    if (!item || typeof item !== "object") continue;
    const p = item as RawGhostPost;
    const type = typeof p.type === "string" ? p.type : "post";
    if (type !== "post") {
      skippedPages++;
      continue;
    }
    const id =
      typeof p.id === "string" && p.id !== ""
        ? p.id
        : typeof p.uuid === "string" && p.uuid !== ""
          ? p.uuid
          : null;
    // No stable id at all = nothing to dedupe or attribute by; skip
    // honestly, same rule the feed parser uses for a guid-less item.
    if (!id) continue;
    const html = typeof p.html === "string" ? p.html : "";
    if (html.trim() === "") {
      failures.push({ id, reason: "no_html" });
      continue;
    }
    const slug = typeof p.slug === "string" ? p.slug : "";
    const status = typeof p.status === "string" ? p.status : null;
    const capped = html.slice(0, MAX_ITEM_CONTENT_CHARS);
    posts.push({
      id,
      slug,
      title:
        (typeof p.title === "string" ? p.title : "")
          .trim()
          .slice(0, MAX_TITLE_LENGTH) || "(untitled)",
      publishedAt: isoDate(
        typeof p.published_at === "string" ? p.published_at : null,
      ),
      contentHtml: capped,
      publishedAtSource: status === null ? null : status === "published",
      preview: capped.length < html.length || detectPreview(capped, null),
    });
  }

  // Newest first, matching the Substack and feed pickers.
  posts.sort(comparePublishedAtDesc);

  return { posts, failures, skippedPages, truncated };
}
