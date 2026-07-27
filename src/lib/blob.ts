/**
 * Blob handling shared by the cover-image pipeline: record-side validation of
 * untrusted blob shapes and the guards for the /img/$did/$cid proxy route.
 * Pure module — no `cloudflare:workers` import, so tests can import it.
 */

/** The atproto blob reference in its JSON (record) representation. */
export type BlobObject = {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
};

/** Both site.standard.document#coverImage and app.bsky.embed.external#thumb
 * declare maxSize 1,000,000 bytes — the cap for blobs WE write, straight
 * from the lexicons. */
export const MAX_IMAGE_BLOB_BYTES = 1_000_000;

/**
 * Serve/render tolerance for blobs OTHER apps wrote: live Leaflet covers
 * reach ~6.3MB despite the lexicon's 1MB maxSize (verified against
 * awarm.space's repo, 2026-07-24) — a strict read-side cap would blank
 * every real third-party cover. 8MB renders observed reality while keeping
 * the /img proxy's memory bounded.
 */
export const MAX_SERVED_IMAGE_BYTES = 8_000_000;

/**
 * Raster image types we accept for covers and serve through /img. The lexicon
 * says `image/*`, but we deliberately exclude image/svg+xml: SVG can carry
 * scripts, and a same-origin image route serving attacker-supplied SVG inline
 * is a stored-XSS vector. Covers are photos/artwork — rasters cover the need.
 */
const IMAGE_MIME_ALLOWLIST = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Is this a serveable/storable image MIME type? Parameters (";charset=…")
 * are stripped before the allowlist check. */
export function isAllowedImageMime(mime: string | null | undefined): boolean {
  if (typeof mime !== "string") return false;
  const bare = mime.split(";")[0].trim().toLowerCase();
  return IMAGE_MIME_ALLOWLIST.has(bare);
}

/**
 * CID as it appears in blob refs — base32 CIDv1 ("bafkrei…") from every
 * modern PDS; base58btc tolerated for legacy blobs. Deliberately restricted
 * to alphanumerics so a validated CID is always safe to interpolate into an
 * XRPC query string (no dots, slashes, percent-escapes).
 */
const BLOB_CID_RE = /^[a-zA-Z0-9]{24,256}$/;

export function isBlobCid(s: string): boolean {
  return BLOB_CID_RE.test(s);
}

/** Validates an untrusted value as a well-formed atproto blob JSON object.
 * (Legacy `{cid, mimeType}` blobs are rejected — nothing we render predates
 * them, and every field below is load-bearing for the /img route.) */
export function isBlobObject(value: unknown): value is BlobObject {
  if (typeof value !== "object" || value === null) return false;
  const blob = value as Partial<BlobObject>;
  return (
    blob.$type === "blob" &&
    typeof blob.mimeType === "string" &&
    typeof blob.size === "number" &&
    typeof blob.ref === "object" &&
    blob.ref !== null &&
    typeof blob.ref.$link === "string" &&
    isBlobCid(blob.ref.$link)
  );
}

/**
 * An untrusted record's coverImage, validated down to what the reader
 * surfaces need: a CID we can serve through /img. Returns null unless the
 * blob is a well-formed, allowlisted raster within the serve tolerance
 * (NOT the 1MB write cap — third-party covers legitimately exceed it).
 */
export function coverImageCid(coverImage: unknown): string | null {
  if (!isBlobObject(coverImage)) return null;
  if (!isAllowedImageMime(coverImage.mimeType)) return null;
  if (coverImage.size <= 0 || coverImage.size > MAX_SERVED_IMAGE_BYTES)
    return null;
  return coverImage.ref.$link;
}

/** Same-origin path for a blob image served through the /img proxy route.
 * Absolute URLs (og:image) mint their origin from ~/lib/origin, never here. */
export function blobImagePath(did: string, cid: string): string {
  return `/img/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
}

/**
 * A document's coverImage validated for reuse as an announce-card thumb
 * (app.bsky.embed.external#thumb). STRICTLY within the lexicon's 1MB cap —
 * unlike the read-side render tolerance — because the PDS validates thumb
 * constraints at write time and an oversized thumb fails the whole announce.
 * Null = announce without a thumb (facet + associatedRefs still ride).
 */
export function thumbFromCover(coverImage: unknown): BlobObject | null {
  if (!isBlobObject(coverImage)) return null;
  if (!isAllowedImageMime(coverImage.mimeType)) return null;
  if (coverImage.size <= 0 || coverImage.size > MAX_IMAGE_BLOB_BYTES)
    return null;
  return coverImage;
}

/** The subset of Request/Response readBodyCapped needs — so it caps an
 * untrusted upstream Response OR an untrusted inbound Request body alike. */
type CappableBody = {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Reads a body with a hard byte cap, streaming — NEVER `arrayBuffer()` on an
 * untrusted source: a hostile PDS (or client) could stream unbounded data (with
 * or without a content-length) and exhaust worker memory. Returns null (and
 * cancels the stream) the moment the cap is crossed; the declared
 * content-length is checked first as a fast path.
 */
export async function readBodyCapped(
  res: CappableBody,
  cap: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength <= cap ? buf : null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
