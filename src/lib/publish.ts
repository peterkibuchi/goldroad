/**
 * Record shaping for the publish loop. Emits `site.standard.document` and
 * `site.standard.publication` — the consensus lexicons —
 * using the typed shapes from @atcute/standard-site. NO custom NSIDs here,
 * ever, until we own a domain to root our lexicon namespace on (NSIDs are
 * permanent, unrenameable public API).
 */
import type * as SiteStandardDocument from "@atcute/standard-site/types/document";
import type * as SiteStandardPublication from "@atcute/standard-site/types/publication";

import type { StandardDocument, StandardPublication } from "~/lib/atproto";
import { stripMarkdown } from "~/lib/feed";

// TID: 13-char base32-sortable record key — 53-bit microsecond timestamp + 10-bit clock id.
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** Both site.standard.document and .publication declare their record key as `tid`. */
export const TID_RE = /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/;

export function generateTid(
  timestampMs = Date.now(),
  clockId = Math.floor(Math.random() * 1024),
): string {
  const value =
    ((BigInt(timestampMs) * 1000n) << 10n) | BigInt(clockId & 0x3ff);
  let tid = "";
  let rest = value;
  for (let i = 0; i < 13; i++) {
    tid = TID_ALPHABET[Number(rest & 31n)] + tid;
    rest >>= 5n;
  }
  return tid;
}

export const MAX_TITLE_LENGTH = 1000; // lexicon: 5000 bytes / 500 graphemes; be conservative
export const MAX_BODY_LENGTH = 100_000; // stay well under PDS record-size limits
const DESCRIPTION_EXCERPT_LENGTH = 300; // lexicon allows 3000 graphemes; keep it brief

/**
 * Hard cap on a writer-written subtitle — the lexicon's own limit for
 * `document.description` (3000 graphemes; the byte limit is 30000, and a
 * grapheme is never fewer than one byte, so this is the binding one).
 */
export const MAX_DEK_LENGTH = 3000;

/**
 * Where a subtitle stops reading like a subtitle. Not enforced: the editor
 * uses it to say honestly that longer lines get trimmed in shared cards and
 * archive rows, and then lets the writer decide.
 */
export const RECOMMENDED_DEK_LENGTH = 200;

/** The lexicon's own blob type for site.standard.document#coverImage
 * (image/*, maxSize 1,000,000) — callers pass the uploadBlob response blob. */
export type CoverImageBlob = NonNullable<
  SiteStandardDocument.Main["coverImage"]
>;

export type DocumentInput = {
  title: string;
  /** Markdown body (BlockNote's lossy markdown export; plain prose is valid markdown). */
  body: string;
  /** The writer's subtitle line. Wins over the generated body excerpt as the
   * record's `description` — blank falls back to the excerpt, as before. */
  dek?: string;
  /** Publication record AT-URI (at://), or a publication URL (https://) for loose documents. */
  site: string;
  /** Canonical path under the publication URL, with leading slash (e.g. /3lz…rkey). */
  path: string;
  /** Cover image blob, already uploaded via com.atproto.repo.uploadBlob —
   * the record reference is what keeps the blob alive on the PDS. */
  coverImage?: CoverImageBlob;
  publishedAt?: Date;
};

/**
 * First ~300 chars of the body as the description excerpt: markdown syntax
 * stripped (descriptions render as plain text in cards), whitespace
 * collapsed. Delegates to the shared hardened strip in ~/lib/feed. Bodies
 * are validated to MAX_BODY_LENGTH before reaching this, so passing that as
 * the scan window is a no-op today — it just keeps the call self-defending
 * if a future caller ever feeds it unvalidated input.
 */
export function excerpt(body: string): string {
  const collapsed = stripMarkdown(body, MAX_BODY_LENGTH);
  if (collapsed.length <= DESCRIPTION_EXCERPT_LENGTH) return collapsed;
  return `${collapsed.slice(0, DESCRIPTION_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function validateTitleAndBody(rawTitle: string, rawBody: string) {
  // A title is one line. The field can't produce a newline, but a paste can —
  // collapse rather than store a record title that renders broken everywhere.
  const title = rawTitle.replace(/\s+/g, " ").trim();
  const body = rawBody.replace(/\r\n/g, "\n").trim();
  if (!title) throw new Error("title is required");
  if (title.length > MAX_TITLE_LENGTH)
    throw new Error(`title exceeds ${MAX_TITLE_LENGTH} characters`);
  if (body.length > MAX_BODY_LENGTH)
    throw new Error(`body exceeds ${MAX_BODY_LENGTH} characters`);
  return { title, body };
}

/**
 * The record's `description`: the writer's subtitle when they wrote one, else
 * the generated body excerpt (the long-standing behaviour), else nothing.
 * One rule, shared by create and edit, so the two can't drift apart.
 */
function resolveDescription(
  rawDek: string | undefined,
  body: string,
): string | undefined {
  const dek = rawDek?.trim() ?? "";
  if (dek.length > MAX_DEK_LENGTH)
    throw new Error(`subtitle exceeds ${MAX_DEK_LENGTH} characters`);
  if (dek) return dek;
  return body ? excerpt(body) : undefined;
}

/**
 * The writer-written subtitle on an existing record, or "" when its
 * `description` is just the generated body excerpt.
 *
 * Editing must not hand a writer machine-written text in a field labelled as
 * theirs: they would be correcting prose they never wrote, and saving would
 * freeze a stale excerpt in place of one that tracks the body. Posts published
 * before the subtitle field existed therefore open with it empty, and keep
 * regenerating their excerpt exactly as they do today.
 */
export function writerDek(doc: {
  description?: string;
  textContent?: string;
}): string {
  const description = doc.description?.trim() ?? "";
  if (!description) return "";
  const body = (doc.textContent ?? "").replace(/\r\n/g, "\n").trim();
  return description === excerpt(body) ? "" : description;
}

/**
 * Builds a site.standard.document record. The markdown body goes in
 * `textContent` (interop-readable; plain prose round-trips cleanly); the
 * rich `content` union waits for our own lexicon, post-domain.
 */
export function buildDocumentRecord(
  input: DocumentInput,
): SiteStandardDocument.Main {
  const { title, body } = validateTitleAndBody(input.title, input.body);

  const record: SiteStandardDocument.Main = {
    $type: "site.standard.document",
    title,
    // GenericUri template type; at:// and https:// URIs always contain ":".
    site: input.site.replace(/\/+$/, "") as `${string}:${string}`,
    path: input.path,
    publishedAt: (input.publishedAt ?? new Date()).toISOString(),
  };
  if (body) record.textContent = body;
  const description = resolveDescription(input.dek, body);
  if (description) record.description = description;
  if (input.coverImage) record.coverImage = input.coverImage;
  return record;
}

/**
 * Merges an edit into an existing site.standard.document: replaces title +
 * textContent/description, sets `updatedAt`, preserves everything else
 * (publishedAt, site, path, tags, bskyPostRef, …). `coverImage` semantics:
 * undefined = keep the existing cover, a blob = replace it, null = remove it
 * (an unreferenced blob is then garbage-collected by the PDS — intended).
 *
 * Refuses documents that carry a rich `content` union (e.g. Leaflet's
 * pub.leaflet.content): we would update the plaintext while readers keep
 * rendering the stale rich content — silent corruption. Those documents are
 * editable in the app that owns their content format.
 */
export function updateDocumentRecord(
  existing: StandardDocument,
  changes: {
    title: string;
    body: string;
    /** Blank means "no subtitle": the description falls back to the body
     * excerpt, exactly as it did before the field existed. */
    dek?: string;
    coverImage?: CoverImageBlob | null;
    updatedAt?: Date;
  },
): SiteStandardDocument.Main {
  if (existing.content != null)
    throw new Error("document has a rich content union — not editable here");
  if (typeof existing.site !== "string" || !existing.site.includes(":"))
    throw new Error("existing document has no valid site");
  const { title, body } = validateTitleAndBody(changes.title, changes.body);

  const record = {
    ...existing,
    $type: "site.standard.document",
    title,
    publishedAt: existing.publishedAt ?? new Date().toISOString(),
    updatedAt: (changes.updatedAt ?? new Date()).toISOString(),
  } as SiteStandardDocument.Main;
  record.textContent = body || undefined;
  record.description = resolveDescription(changes.dek, body);
  if (changes.coverImage) record.coverImage = changes.coverImage;
  else if (changes.coverImage === null) record.coverImage = undefined;
  return record;
}

export const MAX_NAME_LENGTH = 200; // lexicon: 5000 bytes / 500 graphemes; be conservative
export const MAX_PUBLICATION_DESCRIPTION_LENGTH = 1000; // lexicon: 30000 / 3000 graphemes

/** The lexicon's own blob type for site.standard.publication#icon (image/*,
 * maxSize 1,000,000, square, ideally ≥256×256). */
export type IconBlob = NonNullable<SiteStandardPublication.Main["icon"]>;

export type PublicationInput = {
  name: string;
  description?: string;
  /** Base publication URL, no trailing slash — canonical document URL = url + document.path. */
  url: string;
  /** Publication icon: a blob replaces it, null removes it (the PDS then
   * garbage-collects the unreferenced blob), undefined keeps what's there. */
  icon?: IconBlob | null;
};

/**
 * Builds a site.standard.publication record. When `existing` is given, its
 * fields are preserved (basicTheme, preferences, … from other apps) and only
 * name/description/url — plus the icon, when the caller passes one — are
 * replaced.
 */
export function buildPublicationRecord(
  input: PublicationInput,
  existing?: StandardPublication,
): SiteStandardPublication.Main {
  const name = input.name.trim();
  const description = input.description?.trim() ?? "";
  if (!name) throw new Error("name is required");
  if (name.length > MAX_NAME_LENGTH)
    throw new Error(`name exceeds ${MAX_NAME_LENGTH} characters`);
  if (description.length > MAX_PUBLICATION_DESCRIPTION_LENGTH)
    throw new Error(
      `description exceeds ${MAX_PUBLICATION_DESCRIPTION_LENGTH} characters`,
    );
  const url = input.url.replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(url))
    throw new Error("publication url must be an http(s) URL");

  const record = {
    ...existing,
    $type: "site.standard.publication",
    name,
    url: url as `${string}:${string}`,
  } as SiteStandardPublication.Main;
  if (description) record.description = description;
  else record.description = undefined;
  if (input.icon) record.icon = input.icon;
  else if (input.icon === null) record.icon = undefined;
  return record;
}

/**
 * Composes the canonical document URL the standard.site way:
 * publication.url + document.path (verified against live
 * Leaflet records). When `site` is itself an https URL (loose documents),
 * it plays the publication-URL role directly. Returns null when the pieces
 * don't compose (missing path, at:// site with no resolved publication URL).
 */
export function composeDocumentUrl(input: {
  /** document.site — at:// publication URI or https:// publication URL. */
  site?: string;
  /** document.path — leading-slash path under the publication URL. */
  path?: string;
  /** publication.url, resolved by the caller when `site` is an at:// URI. */
  publicationUrl?: string;
}): string | null {
  const { site, path, publicationUrl } = input;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const base = site?.startsWith("https://") ? site : publicationUrl;
  if (typeof base !== "string" || !/^https:\/\/\S+$/.test(base)) return null;
  // A base with a query/fragment would absorb the appended path — a canonical
  // URL we can't compose honestly is better omitted than mangled.
  if (base.includes("?") || base.includes("#")) return null;
  return base.replace(/\/+$/, "") + path;
}

/**
 * Is this publication record one Goldroad manages? `origins` is every origin
 * we have ever minted publication URLs from — canonical + legacy (+ the
 * loopback origin in dev); pass `ownOrigins(requestOrigin)` from ~/lib/origin.
 * Matching by URL prefix (not exact URL) survives handle changes; records
 * from other apps (e.g. *.leaflet.pub) never match, so we never overwrite
 * a publication another app owns.
 */
export function isOwnPublicationUrl(
  url: string | undefined,
  origins: readonly string[],
): boolean {
  return (
    typeof url === "string" &&
    origins.some((origin) => url === origin || url.startsWith(`${origin}/`))
  );
}
