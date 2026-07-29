/**
 * File-upload format detection for /import's generalized upload path — one
 * upload widget now accepts a Substack or Medium export zip, a Ghost JSON
 * export, or a WordPress WXR XML export. Detection is a pure, dependency-free
 * pre-step so /import can pick which parser (~/lib/import-zip,
 * ~/lib/import-medium, ~/lib/import-ghost, ~/lib/import-wxr) to hand the
 * bytes to, before any of those (heavier, dynamically-imported) modules load.
 */

/** Upload cap shared by BOTH zip export flavors (Substack, Medium) — both are
 * text-only HTML archives; real exports measure a few MB, so 50 MB is
 * generous, not permissive. Lives here (not in either zip parser) so
 * /import can reject an oversize file before dynamically importing either
 * (fflate-carrying) parser module. */
export const MAX_EXPORT_ZIP_BYTES = 50 * 1024 * 1024;

/** Upload cap for the two non-zip formats (Ghost JSON, WordPress XML) — read
 * as text in one shot rather than streamed/inflated, so this bounds memory
 * directly. */
export const MAX_EXPORT_TEXT_BYTES = 30 * 1024 * 1024;

export type FileKind = "zip" | "json" | "xml" | "unsupported";

/** Extension-first (what the task described the picker as caring about),
 * falling back to the browser-reported MIME type for files an OS renamed or
 * that a picker dialog stripped the extension from. */
export function detectFileKind(file: File): FileKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".xml")) return "xml";
  const type = file.type.toLowerCase();
  if (type === "application/json") return "json";
  if (type.includes("xml")) return "xml";
  if (type.includes("zip")) return "zip";
  return "unsupported";
}

export type ZipVariant = "substack" | "medium" | "unknown";

const SUBSTACK_CSV_RE = /(?:^|\/)posts\.csv$/i;
const SUBSTACK_POST_RE = /(?:^|\/)posts\/\d+\.[^/]+\.html$/i;
const MEDIUM_POST_RE = /(?:^|\/)posts\/[^/]+\.html$/i;

/**
 * Which export flavor a zip's entry NAMES suggest, before anything is
 * inflated. Substack's shape (a posts.csv, or the numeric-id.slug.html
 * filename pattern even without one) wins on ANY match — it is the more
 * specific signature. Otherwise, any posts/*.html entry reads as a Medium
 * export. Neither pattern present = unknown (the page shows an honest
 * "couldn't find posts in that zip" error naming both formats).
 */
export function detectZipVariant(entryNames: string[]): ZipVariant {
  if (entryNames.some((name) => SUBSTACK_CSV_RE.test(name))) return "substack";
  if (entryNames.some((name) => SUBSTACK_POST_RE.test(name))) return "substack";
  if (entryNames.some((name) => MEDIUM_POST_RE.test(name))) return "medium";
  return "unknown";
}

/** Hostname-shaped input only — the writer types their publication's address
 * to give imported drafts a provenance link (Substack and Ghost exports carry
 * no absolute URL of their own; Medium and WordPress exports do, so they
 * never call this). Anything else (paths, schemes, ports, spaces) is dropped
 * rather than guessed at. */
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
