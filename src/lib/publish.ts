/**
 * Record shaping for the publish loop. Emits `site.standard.document` and
 * `site.standard.publication` — the consensus lexicons — using the typed
 * shapes from @atcute/standard-site. Those stay the primary surface, and the
 * bar for adding to them is high: NSIDs are permanent, unrenameable public API.
 *
 * Exactly one of ours appears here, `pub.goldroad.content.markdown`, as an
 * entry in the document's open `content` union — the field the lexicon
 * declares for extension, holding the format its `textContent` explicitly
 * asks not to hold. See ~/lib/document-content for the reasoning and
 * `lexicons/` for the schema.
 *
 * The other non-standard field, the inline-image blob list, is deliberately
 * NOT an NSID: it's a storage requirement rather than a content format, so it
 * stays a plain namespaced property. See DocumentRecord below.
 */
import type * as SiteStandardDocument from "@atcute/standard-site/types/document";
import type * as SiteStandardPublication from "@atcute/standard-site/types/publication";

import type { StandardDocument, StandardPublication } from "~/lib/atproto";
import {
  type BlobObject,
  isAllowedImageMime,
  isBlobObject,
  MAX_IMAGE_BLOB_BYTES,
} from "~/lib/blob";
import {
  documentBodyMarkdown,
  hasForeignContent,
  type MarkdownContent,
  markdownContent,
} from "~/lib/document-content";
import { plainTextBody, stripMarkdown } from "~/lib/feed";
import { type BasicTheme, themeRecord } from "~/lib/theme";

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
export const MAX_BODY_LENGTH = 100_000; // an editor-side bound on the words; see MAX_RECORD_BYTES for the binding one
const DESCRIPTION_EXCERPT_LENGTH = 300; // lexicon allows 3000 graphemes; keep it brief

/**
 * Hard ceiling on ONE serialized record, in BYTES — the limit that actually
 * binds, and the reason MAX_BODY_LENGTH above is not it.
 *
 * `MAX_BODY_LENGTH` counts UTF-16 code units. A PDS counts the bytes of the
 * JSON it is handed, and the two come apart in both directions at once:
 *
 * - The body is stored TWICE, on purpose — markdown into the `content` union
 *   and its plaintext projection into `textContent` (see buildDocumentRecord).
 *   So even pure ASCII prose weighs roughly twice its character count.
 * - Anything outside ASCII weighs more per character: two bytes for Latin
 *   accents and Greek/Cyrillic, three for CJK, four for emoji. JSON escaping of
 *   quotes, backslashes and newlines adds a little on top.
 *
 * The reference PDS refuses a `com.atproto.repo.*` request body over 150 KB. A
 * 100,000-character Latin post therefore serializes to ~201 KB and comes back
 * 413 — the character cap admits posts the network will not take, and the
 * writer sees a bare publish failure with nothing to act on.
 *
 * 140,000 rather than 150,000 leaves ~10 KB of margin for the XRPC envelope the
 * record travels inside (`repo`, `collection`, `rkey`, `validate`), for the
 * cover and inline-image blob references, and for implementations that count
 * slightly differently. What it leaves a writer is roughly 68,000 characters of
 * Latin prose and around 22,000 of CJK — both far more than one post, and both
 * enforced by measurement rather than guessed at.
 */
export const MAX_RECORD_BYTES = 140_000;

/** Bytes a value occupies once serialized as UTF-8 JSON — what a PDS counts,
 * as against what `String.length` counts. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Is this built record heavier than a PDS will accept? Measured on the record
 * that will actually be sent, never estimated from the body. */
export function isOverRecordByteLimit(record: unknown): boolean {
  return jsonByteLength(record) > MAX_RECORD_BYTES;
}

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

/**
 * An inline body image's blob. The modern blob shape only (`isBlobObject`
 * refuses the legacy `{cid, mimeType}` form the cover type still tolerates) —
 * nothing we write predates it, and /img needs `ref.$link`.
 */
export type InlineImageBlob = BlobObject;

/**
 * Inline body images per document. Generous for an illustrated post or an
 * imported archive item (~5 images is typical), small enough that the blob
 * array can never bloat the record.
 */
export const MAX_INLINE_IMAGES = 50;

/**
 * Where inline-image blobs are referenced from. NOT a `site.standard.document`
 * field — the lexicon has one blob slot (`coverImage`) and none for body
 * images — and it is not decoration either: an atproto PDS only serves blobs
 * that a record references. `com.atproto.sync.getBlob` reads the PERMANENT
 * blobstore key, and `uploadBlob` alone leaves a blob untethered at a temp key
 * (verified against the reference PDS: actor-store/blob/{reader,transactor}.ts
 * — `verifyBlobAndMakePermanent` runs on record write, `deleteDereferencedBlobs`
 * on every subsequent one). So a body image whose CID the record never names
 * would 404 forever, and one dropped from an edit is correctly reclaimed.
 *
 * A plain namespaced field, deliberately not an invented `pub.goldroad.*` NSID:
 * NSIDs are permanent public API (see AGENTS.md) and this is a storage
 * requirement, not a content format. Other apps ignore it; `textContent` stays
 * the universally readable representation, and `/img/<did>/<cid>` names both
 * halves of a `getBlob` call for anyone who wants the original.
 */
export interface DocumentRecord
  extends Omit<SiteStandardDocument.Main, "content"> {
  /**
   * Our entry in the lexicon's open `content` union. Typed as exactly our own
   * shape rather than as the union at large because it is the only thing we
   * ever write here — a record carrying someone else's union is refused before
   * a builder sees it (see updateDocumentRecord).
   */
  content?: MarkdownContent;
  goldroadInlineImages?: InlineImageBlob[];
}

/**
 * The one seam where a document record crosses into the XRPC `record` input
 * (an open JSON object). The generated lexicon type doesn't know about the
 * inline-image field — that IS the point of an extension field — and an
 * interface extending it stops satisfying the input's index signature, so the
 * widening happens here, once, instead of at every write site.
 */
export function toRecordInput(record: DocumentRecord): Record<string, unknown> {
  return { ...record } as Record<string, unknown>;
}

/**
 * The blob CIDs a body actually uses, read off the `/img/<did>/<cid>` proxy
 * paths the editor writes. The DID segment is not matched: it is always the
 * writer's own repo, it may be percent-encoded (blobImagePath encodes it), and
 * the CID alone is what a blob reference is keyed on.
 */
function inlineImageCidsInBody(body: string): Set<string> {
  const cids = new Set<string>();
  for (const match of body.matchAll(
    /\/img\/[^/\s)"'<>]+\/([a-zA-Z0-9]{24,256})/g,
  )) {
    cids.add(match[1]);
  }
  return cids;
}

/**
 * The inline-image blobs a record must reference: every candidate blob whose
 * CID the body still uses, validated to the same terms as a cover (well-formed
 * blob, allowlisted raster, within the lexicon's 1MB cap) and deduped.
 *
 * Candidates are untrusted — they arrive as JSON from the browser (the blobs
 * `/api/publish?intent=uploadImage` handed back) merged with whatever the
 * previous version of the record carried. Filtering by the body is what keeps
 * the two in step: an image the writer deleted loses its reference and the PDS
 * reclaims it; an image they kept keeps resolving after the edit.
 */
export function inlineImagesForBody(
  body: string,
  candidates: readonly unknown[],
): InlineImageBlob[] {
  const used = inlineImageCidsInBody(body);
  if (used.size === 0) return [];
  const seen = new Set<string>();
  const out: InlineImageBlob[] = [];
  for (const candidate of candidates) {
    if (out.length >= MAX_INLINE_IMAGES) break;
    if (!isBlobObject(candidate)) continue;
    if (!isAllowedImageMime(candidate.mimeType)) continue;
    if (candidate.size <= 0 || candidate.size > MAX_IMAGE_BLOB_BYTES) continue;
    const cid = candidate.ref.$link;
    if (!used.has(cid) || seen.has(cid)) continue;
    seen.add(cid);
    out.push(candidate);
  }
  return out;
}

/**
 * The browser's `images` form field → candidate blobs. Malformed JSON is an
 * empty list, never a failed publish: the words are what matter, and an image
 * that loses its reference degrades to a broken picture, not a lost post.
 */
export function parseInlineImagesField(raw: unknown): unknown[] {
  if (typeof raw !== "string" || raw === "") return [];
  // Bounded before parsing: ~200 bytes per blob entry, so this admits every
  // legitimate payload and refuses a pathological one without parsing it.
  if (raw.length > MAX_INLINE_IMAGES * 500) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
  /** Candidate inline-image blobs (browser-submitted, untrusted) — filtered
   * against the body by inlineImagesForBody before they reach the record. */
  inlineImageSources?: readonly unknown[];
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

/** Minimal entity decode for text pulled back out of an HTML attribute or a
 * <figcaption>. Ampersand LAST so "&amp;lt;" doesn't become "<". */
function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&");
}

/** Markdown image syntax for one image. A URL with spaces or parens takes the
 * angle-bracket form; `[` and `]` can't appear unescaped in the alt text. */
function imageMarkdown(alt: string, src: string): string {
  const text = alt.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  const url = /[\s()]/.test(src) ? `<${src}>` : src;
  return `![${text}](${url})`;
}

/**
 * `<figure><img …><figcaption>…</figcaption></figure>` → real markdown.
 *
 * BlockNote exports a CAPTIONED image as that raw HTML rather than as
 * `![alt](src)` (uncaptioned images export as markdown). Reader surfaces
 * render markdown with no rehype-raw — raw HTML is dropped, deliberately and
 * permanently — so storing the export verbatim would make every captioned
 * image invisible to readers while looking perfectly fine in the editor.
 * Folding it here, on the way into the record, keeps the picture and turns
 * the caption into the italic line underneath that it already looks like.
 *
 * Runs on every publish and edit, so a body that never had a figure in it
 * pays one failed regex match.
 */
export function foldImageFigures(markdown: string): string {
  if (!markdown.includes("<figure")) return markdown;
  return markdown.replace(
    /<figure[^>]*>\s*<img\b([^>]*)>\s*(?:<figcaption[^>]*>([\s\S]*?)<\/figcaption>\s*)?<\/figure>/gi,
    (whole, attrs: string, caption: string | undefined) => {
      const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
      if (!src) return whole; // nothing to point at — leave it alone
      const alt = decodeBasicEntities(
        /\balt\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "",
      );
      const image = imageMarkdown(alt, decodeBasicEntities(src));
      // Tags out BEFORE entities in: decoding first would let an escaped
      // "&lt;hi&gt;" become a real tag and get stripped as markup.
      const text = decodeBasicEntities((caption ?? "").replace(/<[^>]*>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
      // A caption identical to the alt text would just read twice.
      return text && text !== alt.trim()
        ? `${image}\n\n*${text.replace(/\*/g, "\\*")}*`
        : image;
    },
  );
}

function validateTitleAndBody(rawTitle: string, rawBody: string) {
  // A title is one line. The field can't produce a newline, but a paste can —
  // collapse rather than store a record title that renders broken everywhere.
  const title = rawTitle.replace(/\s+/g, " ").trim();
  const body = foldImageFigures(rawBody.replace(/\r\n/g, "\n")).trim();
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
  textContent?: unknown;
  content?: unknown;
}): string {
  const description = doc.description?.trim() ?? "";
  if (!description) return "";
  // Compared against an excerpt of the MARKDOWN body, which is what the
  // description was generated from. Reading textContent directly would
  // compare against the plaintext projection on post-mint records and hand
  // the writer a machine-written excerpt in a field labelled as theirs.
  const body = documentBodyMarkdown(doc).replace(/\r\n/g, "\n").trim();
  return description === excerpt(body) ? "" : description;
}

/**
 * Builds a site.standard.document record. The body is written twice, on
 * purpose: the markdown into the `content` union (our lexicon, lossless, what
 * our own reader and editor read) and its plaintext projection into
 * `textContent` (what the lexicon specifies that field holds, and what every
 * reader that doesn't know our union reads). Neither is optional — a record
 * with only the union would be unreadable to the rest of the network, and one
 * with only the projection is the lossy state this pair replaced.
 */
export function buildDocumentRecord(input: DocumentInput): DocumentRecord {
  const { title, body } = validateTitleAndBody(input.title, input.body);

  const record: DocumentRecord = {
    $type: "site.standard.document",
    title,
    // GenericUri template type; at:// and https:// URIs always contain ":".
    site: input.site.replace(/\/+$/, "") as `${string}:${string}`,
    path: input.path,
    publishedAt: (input.publishedAt ?? new Date()).toISOString(),
  };
  if (body) {
    record.content = markdownContent(body);
    // Can come back empty from a body that is only an un-alt-texted image;
    // an empty string is not a plaintext representation of anything, so the
    // field is omitted exactly as it is for an empty body.
    const plain = plainTextBody(body, MAX_BODY_LENGTH);
    if (plain) record.textContent = plain;
  }
  const description = resolveDescription(input.dek, body);
  if (description) record.description = description;
  if (input.coverImage) record.coverImage = input.coverImage;
  const inline = inlineImagesForBody(body, input.inlineImageSources ?? []);
  if (inline.length > 0) record.goldroadInlineImages = inline;
  return record;
}

/**
 * Stand-ins for the two fields a pre-publish measurement cannot know: the
 * document's `site` (the writer's publication record, whose URI is only
 * resolved during the publish itself) and its `path` (minted from the rkey,
 * which does not exist yet). Both are written at the longest shape this app
 * ever produces — a `did:plc` publication URI and a 13-character TID path — so
 * a measurement can come out larger than the record that ships, never smaller.
 * `publishedAt` is fixed for the same reason: every ISO timestamp is the same
 * length, so a constant one measures identically to the real one.
 */
const MEASURED_SITE = `at://did:plc:${"x".repeat(24)}/site.standard.publication/${"3".repeat(13)}`;
const MEASURED_PATH = `/${"3".repeat(13)}`;
const MEASURED_PUBLISHED_AT = new Date(0);

/**
 * What a draft will weigh as a record, in bytes — the measurement the EDITOR
 * makes before it lets a publish navigate.
 *
 * It has to happen there and not only on the server, for the same reason the
 * character cap is checked there: once the form submits, the only copy of a
 * long essay is a redirect away, and the draft row cannot hold an over-length
 * body either. A refusal that leaves every word on screen is the only one a
 * writer can act on.
 *
 * Builds the real record through the real builder rather than adding up field
 * lengths, so the number tracks the record shape automatically — including the
 * body being stored twice, which is the whole reason a character count is not
 * an answer here.
 */
export function documentRecordByteLength(input: {
  title: string;
  body: string;
  dek?: string;
  inlineImageSources?: readonly unknown[];
}): number {
  try {
    return jsonByteLength(
      buildDocumentRecord({
        ...input,
        site: MEASURED_SITE,
        path: MEASURED_PATH,
        publishedAt: MEASURED_PUBLISHED_AT,
      }),
    );
  } catch {
    // A record that cannot be built has no size to report, and the caller's
    // own refusal — no title, body past the character cap — is the one that
    // applies. Answering "too large" here would be a wrong answer to a
    // different question.
    return 0;
  }
}

/**
 * Merges an edit into an existing site.standard.document: replaces title +
 * textContent/description, sets `updatedAt`, preserves everything else
 * (publishedAt, site, path, tags, bskyPostRef, …). `coverImage` semantics:
 * undefined = keep the existing cover, a blob = replace it, null = remove it
 * (an unreferenced blob is then garbage-collected by the PDS — intended).
 *
 * Refuses documents carrying a FOREIGN content union (e.g. Leaflet's
 * pub.leaflet.content): we would update the plaintext while readers keep
 * rendering the stale rich content — silent corruption. Those documents are
 * editable in the app that owns their content format.
 *
 * Our own union is not foreign, and a document carrying it is fully editable —
 * that is the whole point of having minted it. The check used to be
 * `content != null`, which was correct only while we never wrote the field;
 * left as-is it would have made every post we published unopenable the moment
 * we started.
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
    /** Blobs uploaded during THIS edit. The record's existing references are
     * merged in automatically, so an untouched image keeps resolving. */
    inlineImageSources?: readonly unknown[];
    updatedAt?: Date;
  },
): DocumentRecord {
  if (hasForeignContent(existing))
    throw new Error("document has a foreign content union — not editable here");
  if (typeof existing.site !== "string" || !existing.site.includes(":"))
    throw new Error("existing document has no valid site");
  const { title, body } = validateTitleAndBody(changes.title, changes.body);

  const record = {
    ...existing,
    $type: "site.standard.document",
    title,
    publishedAt: existing.publishedAt ?? new Date().toISOString(),
    updatedAt: (changes.updatedAt ?? new Date()).toISOString(),
  } as DocumentRecord;
  // Both representations are rewritten together, always. An edit that updated
  // one and left the other would leave the record self-contradicting, and
  // whichever half a given reader trusts would be the stale one. Emptying the
  // body clears both — including the union inherited from `existing`, which
  // would otherwise survive as the old text under an empty post.
  record.content = body ? markdownContent(body) : undefined;
  record.textContent = body
    ? plainTextBody(body, MAX_BODY_LENGTH) || undefined
    : undefined;
  record.description = resolveDescription(changes.dek, body);
  if (changes.coverImage) record.coverImage = changes.coverImage;
  else if (changes.coverImage === null) record.coverImage = undefined;
  // Recomputed from the SAVED body, never inherited wholesale: an image the
  // writer deleted must lose its reference (the PDS then reclaims the blob),
  // and one they kept must keep it (the PDS would otherwise reclaim that).
  const inline = inlineImagesForBody(body, [
    ...(changes.inlineImageSources ?? []),
    ...(Array.isArray(existing.goldroadInlineImages)
      ? existing.goldroadInlineImages
      : []),
  ]);
  record.goldroadInlineImages = inline.length > 0 ? inline : undefined;
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
 * Sets (or clears) the theme on an existing publication record, preserving
 * every other field — the same "merge, never rebuild" rule
 * `buildPublicationRecord` follows, for the same reason: this record may carry
 * fields written by other apps on the shared lexicon, and a save here must not
 * be a quiet delete for them.
 *
 * `theme: null` REMOVES `basicTheme`, which is how "use the defaults" is
 * expressed in the writer's repo. Not a stored copy of our palette — an
 * absence. A writer who reverts should look, to every other app reading their
 * record, exactly like a writer who never set a theme.
 *
 * Takes the existing record because there is nowhere else for a theme to live:
 * `site.standard.publication` embeds `basicTheme` rather than referencing it
 * (see ~/lib/theme for the lexicon reading), so a theme write IS a publication
 * write.
 */
export function withBasicTheme(
  existing: StandardPublication,
  theme: BasicTheme | null,
): SiteStandardPublication.Main {
  if (typeof existing.name !== "string" || existing.name.trim() === "")
    throw new Error("publication has no name");
  if (
    typeof existing.url !== "string" ||
    !/^https?:\/\/\S+$/.test(existing.url)
  )
    throw new Error("publication has no valid url");
  const record = {
    ...existing,
    $type: "site.standard.publication",
  } as SiteStandardPublication.Main;
  record.basicTheme = theme ? themeRecord(theme) : undefined;
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
