// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  blobImagePath,
  coverImageCid,
  isAllowedImageMime,
  isBlobCid,
  isBlobObject,
  MAX_IMAGE_BLOB_BYTES,
  MAX_SERVED_IMAGE_BYTES,
  readBodyCapped,
  thumbFromCover,
} from "../lib/blob";

const CID = "bafkreicanarycanarycanarycanarycanarycanary";

const blob = (overrides: Record<string, unknown> = {}) => ({
  $type: "blob",
  ref: { $link: CID },
  mimeType: "image/jpeg",
  size: 12345,
  ...overrides,
});

describe("isAllowedImageMime — the /img serve + cover store allowlist", () => {
  it("accepts the raster types", () => {
    for (const mime of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/gif",
    ])
      expect(isAllowedImageMime(mime)).toBe(true);
  });

  it("rejects SVG — script-capable, a stored-XSS vector on a same-origin route", () => {
    expect(isAllowedImageMime("image/svg+xml")).toBe(false);
  });

  it("rejects non-images and junk", () => {
    for (const mime of [
      "text/html",
      "application/pdf",
      "image/",
      "",
      null,
      undefined,
    ])
      expect(isAllowedImageMime(mime)).toBe(false);
  });

  it("strips parameters and normalizes case before the check", () => {
    expect(isAllowedImageMime("IMAGE/JPEG; charset=utf-8")).toBe(true);
    // parameters must not smuggle a disallowed base type past the check
    expect(isAllowedImageMime("image/svg+xml; foo=image/png")).toBe(false);
  });
});

describe("isBlobCid — safe to interpolate into an XRPC query", () => {
  it("accepts base32 CIDv1 shapes", () => {
    expect(isBlobCid(CID)).toBe(true);
  });

  it("rejects path/query metacharacters and short junk", () => {
    for (const bad of [
      "",
      "short",
      "../../../etc/passwd",
      `${CID}/extra`,
      `${CID}?x=1`,
      `${CID}%2f`,
      "bafk reispace00000000000000000",
    ])
      expect(isBlobCid(bad)).toBe(false);
  });
});

describe("isBlobObject / coverImageCid — untrusted record shapes", () => {
  it("accepts a well-formed blob JSON object", () => {
    expect(isBlobObject(blob())).toBe(true);
    expect(coverImageCid(blob())).toBe(CID);
  });

  it("rejects malformed shapes", () => {
    expect(isBlobObject(null)).toBe(false);
    expect(isBlobObject("bafk...")).toBe(false);
    expect(isBlobObject(blob({ $type: "not-blob" }))).toBe(false);
    expect(isBlobObject(blob({ ref: { $link: 42 } }))).toBe(false);
    expect(isBlobObject(blob({ ref: null }))).toBe(false);
    expect(isBlobObject(blob({ size: "12345" }))).toBe(false);
    // legacy {cid, mimeType} blobs are deliberately rejected
    expect(isBlobObject({ cid: CID, mimeType: "image/png" })).toBe(false);
  });

  it("coverImageCid rejects disallowed mime types and out-of-tolerance sizes", () => {
    expect(coverImageCid(blob({ mimeType: "image/svg+xml" }))).toBeNull();
    expect(coverImageCid(blob({ mimeType: "text/html" }))).toBeNull();
    expect(
      coverImageCid(blob({ size: MAX_SERVED_IMAGE_BYTES + 1 })),
    ).toBeNull();
    expect(coverImageCid(blob({ size: 0 }))).toBeNull();
    expect(coverImageCid(undefined)).toBeNull();
  });

  it("coverImageCid tolerates covers above the 1MB WRITE cap — live Leaflet covers reach ~6MB", () => {
    // The lexicon says maxSize 1,000,000; reality (awarm.space, 2026-07-24)
    // disagrees. Read-side strictness would blank real third-party covers.
    expect(coverImageCid(blob({ size: 6_299_017 }))).toBe(CID);
    expect(MAX_SERVED_IMAGE_BYTES).toBeGreaterThan(MAX_IMAGE_BLOB_BYTES);
  });

  it("thumbFromCover enforces the STRICT 1MB thumb cap — the PDS rejects oversized thumbs at write", () => {
    expect(thumbFromCover(blob())).toEqual(blob());
    expect(thumbFromCover(blob({ size: MAX_IMAGE_BLOB_BYTES }))).not.toBeNull();
    // a big third-party cover renders on our pages but must NOT ride as thumb
    expect(thumbFromCover(blob({ size: 6_299_017 }))).toBeNull();
    expect(thumbFromCover(blob({ mimeType: "image/svg+xml" }))).toBeNull();
    expect(thumbFromCover(undefined)).toBeNull();
  });
});

describe("blobImagePath", () => {
  it("URL-encodes both segments", () => {
    expect(blobImagePath("did:plc:abc123", CID)).toBe(
      `/img/did%3Aplc%3Aabc123/${CID}`,
    );
  });
});

describe("readBodyCapped — bounded reads from an untrusted upstream", () => {
  it("returns the full body when under the cap", async () => {
    const res = new Response("hello");
    const bytes = await readBodyCapped(res, 100);
    expect(bytes && new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("rejects on the declared content-length fast path", async () => {
    const res = new Response("x".repeat(10), {
      headers: { "content-length": "1000" },
    });
    expect(await readBodyCapped(res, 100)).toBeNull();
  });

  it("rejects a streaming body that crosses the cap with no content-length", async () => {
    // A hostile PDS can stream forever without declaring a length — the read
    // must stop AT the cap, not buffer first. This stream would produce
    // ~10MB if fully read; the test finishing fast proves early cancel.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 10_000) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const res = new Response(stream);
    expect(await readBodyCapped(res, 4096)).toBeNull();
    expect(pulls).toBeLessThan(100);
  });

  it("accepts a body exactly at the cap", async () => {
    const res = new Response(new Uint8Array(64));
    const bytes = await readBodyCapped(res, 64);
    expect(bytes?.byteLength).toBe(64);
  });
});
