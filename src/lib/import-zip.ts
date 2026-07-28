/**
 * Substack export-zip parsing — runs entirely in the BROWSER; the zip never
 * leaves the writer's machine. /import loads this module (and, through it,
 * fflate) with a dynamic import only when an upload actually happens, so
 * neither enters the worker bundle or the page's initial chunk.
 *
 * Export format (verified 2026-07-28 against Substack's help center — a
 * publication's Settings → Exports → "Create new export" — and against the
 * structure Ghost's importer expects, TryGhost/migrate `mg-substack`):
 *
 *   posts.csv                — one metadata row per post. Header-driven here;
 *                              current columns include post_id, post_date,
 *                              is_published, type, audience, title, subtitle.
 *   posts/<id>.<slug>.html   — one file per post, body HTML only; the file
 *                              name minus ".html" equals the CSV's post_id
 *                              (e.g. "1234.my-post").
 *
 * Both halves are treated as best-effort: exports have shipped with CSV rows
 * missing their HTML file and vice versa, so this parser DRIVES FROM THE HTML
 * FILES, decorates from the CSV when a row matches, and falls back to
 * filename-derived titles when the CSV is absent or unreadable. Per-entry
 * failures (corrupt or oversized entries) are reported individually and never
 * abort the run.
 *
 * Trust posture: the zip is writer-supplied but still untrusted bytes.
 * Entries are only inflated one at a time, each gated by the size the central
 * directory declares AND re-checked after inflation (a bomb that lies about
 * its size still dies at the cap), with a whole-run inflated-bytes budget on
 * top. The HTML itself is sanitized downstream exactly like feed HTML: the
 * BlockNote conversion structurally drops script/iframe/unknown nodes.
 */
import { unzipSync } from "fflate";

import {
  detectPreview,
  guidHash,
  isoDate,
  MAX_EXPORT_POSTS,
} from "~/lib/import";
import { MAX_TITLE_LENGTH } from "~/lib/publish";

export { guidHash, MAX_EXPORT_POSTS };

/** Upload cap. Substack's posts export is text-only HTML + CSVs — real
 * archives measure a few MB; 50 MB is generous, not permissive. */
export const MAX_EXPORT_ZIP_BYTES = 50 * 1024 * 1024;

/** Per-entry inflated cap: matches the feed pipeline's whole-feed bound — a
 * single post's HTML has no business being larger. */
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/** Whole-run inflated budget across all entries — the zip-bomb backstop. */
export const MAX_TOTAL_INFLATED_BYTES = 100 * 1024 * 1024;

/**
 * Total central-directory entries tolerated. Each per-entry inflation walks
 * the whole directory again (fflate has no directory cache), so entry COUNT —
 * not just bytes — is attack surface: ~100 bytes buys an empty entry, and a
 * 50 MB zip could carry ~400k of them, turning the parse quadratic and
 * hanging the tab. A real Substack export carries a handful of files per
 * post (HTML + per-post stats CSVs); 10k entries is generous, not permissive.
 */
export const MAX_ZIP_ENTRIES = 10_000;

/** The archive was refused before any entry was inflated — too many entries
 * to be a Substack posts export. The page shows its own copy for this. */
export class ExportTooComplexError extends Error {}

export type ZipPostFailure = {
  name: string;
  reason: "corrupt" | "too_large";
};

export type ZipPost = {
  /** Filename minus ".html" — equals the CSV post_id ("1234.my-post"). The
   * stable identity a re-exported archive keeps, so it seeds the ledger guid. */
  postId: string;
  /** postId minus its numeric prefix — the public URL path segment. */
  slug: string;
  title: string;
  /** ISO timestamp from the CSV's post_date, or null (no CSV / no date). */
  publishedAt: string | null;
  contentHtml: string;
  /** false = the CSV says the post never published (a Substack draft);
   * null = unknown (no CSV row matched). */
  publishedAtSource: boolean | null;
  /** Paywall-stub heuristic (same one the feed path uses): teaser-length
   * content is flagged, never silently imported as if complete. */
  preview: boolean;
};

export type ParsedExport = {
  posts: ZipPost[];
  csvFound: boolean;
  failures: ZipPostFailure[];
  /** Posts found beyond MAX_EXPORT_POSTS: counted in the archive's own
   * order and never inflated — only the cap's worth of entries is read. */
  truncated: number;
};

/** Ledger identity for an export post — namespaced so it can never collide
 * with a feed guid, and stable across re-exports of the same publication
 * (Substack keeps post_id fixed), which is what makes re-uploads idempotent. */
export function zipPostGuid(postId: string): string {
  return `substack-export:${postId}`;
}

/** Hostname-shaped input only — the writer types their publication's address
 * to give imported drafts a provenance link. Anything else (paths, schemes,
 * ports, spaces) is dropped rather than guessed at. */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  if (trimmed === "" || trimmed.length > 253) return null;
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
      trimmed,
    )
  )
    return null;
  return trimmed.toLowerCase();
}

/** The post's public URL, reconstructed Substack-style (`https://host/p/slug`)
 * from the confirmed host. Null host = no provenance — the post imports as a
 * regular draft, said plainly in the UI. */
export function constructSourceUrl(
  host: string | null,
  slug: string,
): string | null {
  if (!host || slug === "") return null;
  // Slugs are filename-derived: keep them to URL-path-safe characters rather
  // than percent-encoding surprises into a stored provenance link.
  if (!/^[a-zA-Z0-9._~-]+$/.test(slug)) return null;
  return `https://${host}/p/${slug}`;
}

/**
 * Minimal RFC 4180 CSV: quoted fields, doubled-quote escapes, newlines inside
 * quotes, CRLF or LF rows. Substack's export quotes freely (titles carry
 * commas), so a split-on-comma would corrupt exactly the rows that matter.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A lone trailing newline yields [""] — not a row.
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

type CsvMeta = {
  title: string | null;
  publishedAt: string | null;
  isPublished: boolean | null;
};

/**
 * posts.csv → post_id-keyed metadata. Header-driven on purpose: Substack has
 * reordered and added columns before, so positions are never trusted. A CSV
 * without a post_id column is treated as absent (filename fallback applies).
 */
export function parsePostsCsv(text: string): Map<string, CsvMeta> | null {
  const rows = parseCsv(text);
  if (rows.length === 0) return null;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idCol = header.indexOf("post_id");
  if (idCol === -1) return null;
  const dateCol = header.indexOf("post_date");
  const publishedCol = header.indexOf("is_published");
  const titleCol = header.indexOf("title");
  const meta = new Map<string, CsvMeta>();
  for (const row of rows.slice(1)) {
    const postId = row[idCol]?.trim();
    if (!postId) continue;
    const title = titleCol === -1 ? null : (row[titleCol]?.trim() ?? null);
    const rawPublished =
      publishedCol === -1
        ? null
        : (row[publishedCol]?.trim().toLowerCase() ?? null);
    meta.set(postId, {
      title: title || null,
      publishedAt: dateCol === -1 ? null : isoDate(row[dateCol] ?? null),
      isPublished:
        rawPublished === "true"
          ? true
          : rawPublished === "false"
            ? false
            : null,
    });
  }
  return meta;
}

/** "my-post-slug" → "My post slug" — the honest fallback title when the CSV
 * row is missing. Writers rename it in the editor anyway. */
function titleFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (words === "") return "(untitled)";
  return (words[0].toUpperCase() + words.slice(1)).slice(0, MAX_TITLE_LENGTH);
}

/** posts/<id>.<slug>.html, at the root or one archive-folder deep (both ship
 * in the wild). macOS resource-fork noise (__MACOSX/, ._*) is not a post. */
const POST_ENTRY_RE = /(?:^|\/)posts\/([^/]+)\.html$/;

function postIdOf(name: string): string | null {
  if (name.includes("__MACOSX/")) return null;
  const match = POST_ENTRY_RE.exec(name);
  if (!match || match[1].startsWith(".")) return null;
  return match[1];
}

function isPostsCsv(name: string): boolean {
  return (
    !name.includes("__MACOSX/") &&
    (name === "posts.csv" || name.endsWith("/posts.csv")) &&
    !name.split("/").at(-1)?.startsWith(".")
  );
}

/** Inflates exactly one named entry, size-gated before AND after inflation
 * (central-directory sizes are attacker-controlled claims, not facts). */
function inflateEntry(
  bytes: Uint8Array,
  name: string,
  cap: number,
): Uint8Array {
  let declaredOversize = false;
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (file.name !== name) return false;
      if (file.originalSize > cap) {
        declaredOversize = true;
        return false;
      }
      return true;
    },
  });
  if (declaredOversize) throw new EntryTooLargeError();
  const data = files[name];
  if (!data) throw new Error(`entry vanished: ${name}`);
  if (data.length > cap) throw new EntryTooLargeError();
  return data;
}

class EntryTooLargeError extends Error {}

/**
 * The whole export → picker-ready posts. Throws only when the bytes aren't a
 * readable zip at all, or carry more entries than a posts export plausibly
 * would (ExportTooComplexError — refused BEFORE any inflation, because each
 * per-entry inflation re-walks the directory and entry count is what would
 * make that quadratic). Everything past those two gates degrades per-item:
 * entries are inflated ONE AT A TIME so a single corrupt stream (or an
 * oversize claim) costs that post alone, never the archive.
 */
export function parseSubstackExport(bytes: Uint8Array): ParsedExport {
  // Listing pass: names + declared sizes only, nothing inflated.
  const entryNames: string[] = [];
  unzipSync(bytes, {
    filter: (file) => {
      entryNames.push(file.name);
      return false;
    },
  });
  if (entryNames.length > MAX_ZIP_ENTRIES) throw new ExportTooComplexError();

  const decoder = new TextDecoder();
  let inflatedBudget = MAX_TOTAL_INFLATED_BYTES;
  const inflate = (name: string, cap: number): Uint8Array => {
    const data = inflateEntry(bytes, name, Math.min(cap, inflatedBudget));
    inflatedBudget -= data.length;
    return data;
  };

  // The CSV first (metadata for everything else). Unreadable = absent.
  let csv: Map<string, CsvMeta> | null = null;
  const csvName = entryNames.find(isPostsCsv);
  if (csvName) {
    try {
      csv = parsePostsCsv(decoder.decode(inflate(csvName, MAX_ENTRY_BYTES)));
    } catch {
      csv = null;
    }
  }

  // Candidates first (names only, no inflation), deduped by post id — the
  // archive cap applies HERE, before any per-entry work, so posts past it
  // cost nothing but the count reported honestly as `truncated`.
  const candidates: { name: string; postId: string }[] = [];
  const seen = new Set<string>();
  for (const name of entryNames) {
    const postId = postIdOf(name);
    if (!postId || seen.has(postId)) continue;
    seen.add(postId);
    candidates.push({ name, postId });
  }
  const truncated = Math.max(0, candidates.length - MAX_EXPORT_POSTS);

  const failures: ZipPostFailure[] = [];
  const posts: ZipPost[] = [];
  for (const { name, postId } of candidates.slice(0, MAX_EXPORT_POSTS)) {
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
    const meta = csv?.get(postId) ?? null;
    const slug = postId.replace(/^\d+\./, "");
    posts.push({
      postId,
      slug,
      title: (meta?.title ?? titleFromSlug(slug)).slice(0, MAX_TITLE_LENGTH),
      publishedAt: meta?.publishedAt ?? null,
      contentHtml: html,
      publishedAtSource: meta?.isPublished ?? null,
      preview: detectPreview(html, null),
    });
  }

  // Newest first (unknown dates last, then by numeric id descending) — the
  // picker reads like the feed path and the dashboard: recent work on top.
  posts.sort((a, b) => {
    const at = a.publishedAt
      ? Date.parse(a.publishedAt)
      : Number.NEGATIVE_INFINITY;
    const bt = b.publishedAt
      ? Date.parse(b.publishedAt)
      : Number.NEGATIVE_INFINITY;
    if (at !== bt) return bt - at;
    return (
      (Number.parseInt(b.postId, 10) || 0) -
      (Number.parseInt(a.postId, 10) || 0)
    );
  });

  return {
    posts,
    csvFound: csv !== null,
    failures,
    truncated,
  };
}
