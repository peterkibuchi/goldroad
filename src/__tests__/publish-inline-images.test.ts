// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * Inline-image blob references on the record.
 *
 * The rule these pin: the record's blob list is derived from the SAVED body,
 * never inherited wholesale. An atproto PDS serves only blobs a record
 * references and reclaims the rest, so a reference that outlives its markdown
 * leaks and a missing one is a permanently broken picture.
 */
import {
  buildDocumentRecord,
  foldImageFigures,
  inlineImagesForBody,
  MAX_INLINE_IMAGES,
  parseInlineImagesField,
  updateDocumentRecord,
} from "../lib/publish";

const DID = "did:plc:fake2222222222writer2222";
const CID_A = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CID_B = "bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const blob = (cid: string, over: Record<string, unknown> = {}) => ({
  $type: "blob",
  ref: { $link: cid },
  mimeType: "image/jpeg",
  size: 40_000,
  ...over,
});

const imageMarkdown = (cid: string, did = DID) =>
  `![a cat](/img/${encodeURIComponent(did)}/${cid})`;

describe("inlineImagesForBody", () => {
  it("keeps the blobs the body references, in body-independent candidate order", () => {
    const kept = inlineImagesForBody(
      `Words.\n\n${imageMarkdown(CID_A)}\n\n${imageMarkdown(CID_B)}`,
      [blob(CID_A), blob(CID_B)],
    );
    expect(kept.map((b) => b.ref.$link)).toEqual([CID_A, CID_B]);
  });

  it("drops a blob the body no longer references — the PDS then reclaims it", () => {
    expect(
      inlineImagesForBody(`Words. ${imageMarkdown(CID_A)}`, [
        blob(CID_A),
        blob(CID_B),
      ]),
    ).toHaveLength(1);
    expect(inlineImagesForBody("Just words.", [blob(CID_A)])).toEqual([]);
  });

  it("matches an unencoded DID in the path too", () => {
    expect(
      inlineImagesForBody(`![x](/img/${DID}/${CID_A})`, [blob(CID_A)]),
    ).toHaveLength(1);
  });

  it("dedupes a CID used twice in one body", () => {
    const kept = inlineImagesForBody(
      `${imageMarkdown(CID_A)} and again ${imageMarkdown(CID_A)}`,
      [blob(CID_A), blob(CID_A)],
    );
    expect(kept).toHaveLength(1);
  });

  it("refuses malformed, non-raster and over-cap candidates", () => {
    const body = imageMarkdown(CID_A);
    for (const bad of [
      null,
      "nope",
      { ref: { $link: CID_A } },
      blob(CID_A, { mimeType: "image/svg+xml" }),
      blob(CID_A, { size: 1_000_001 }),
      blob(CID_A, { size: 0 }),
      blob(CID_A, { ref: { $link: "short" } }),
    ]) {
      expect(inlineImagesForBody(body, [bad])).toEqual([]);
    }
  });

  it("stops at MAX_INLINE_IMAGES", () => {
    const cids = Array.from(
      { length: MAX_INLINE_IMAGES + 5 },
      (_, i) => `bafkrei${String(i).padStart(32, "0")}`,
    );
    const body = cids.map((cid) => imageMarkdown(cid)).join("\n\n");
    expect(
      inlineImagesForBody(
        body,
        cids.map((cid) => blob(cid)),
      ),
    ).toHaveLength(MAX_INLINE_IMAGES);
  });
});

describe("parseInlineImagesField", () => {
  it("reads a JSON array of blobs", () => {
    expect(parseInlineImagesField(JSON.stringify([blob(CID_A)]))).toEqual([
      blob(CID_A),
    ]);
  });

  it("answers empty for junk rather than failing a publish", () => {
    for (const raw of [
      undefined,
      "",
      "{not json",
      JSON.stringify({ nope: true }),
      "x".repeat(MAX_INLINE_IMAGES * 500 + 1),
    ]) {
      expect(parseInlineImagesField(raw)).toEqual([]);
    }
  });
});

describe("records carry their body's images", () => {
  const base = {
    title: "Illustrated",
    site: "https://example.com/@writer",
    path: "/3l",
  };

  it("buildDocumentRecord references them; omits the field when there are none", () => {
    const record = buildDocumentRecord({
      ...base,
      body: imageMarkdown(CID_A),
      inlineImageSources: [blob(CID_A)],
    });
    expect(record.goldroadInlineImages).toEqual([blob(CID_A)]);
    expect(
      buildDocumentRecord({ ...base, body: "No pictures." })
        .goldroadInlineImages,
    ).toBeUndefined();
  });

  it("an edit keeps untouched images without the browser resending them", () => {
    const existing = {
      $type: "site.standard.document",
      title: "Illustrated",
      site: "https://example.com/@writer",
      path: "/3l",
      publishedAt: "2026-01-01T00:00:00.000Z",
      textContent: imageMarkdown(CID_A),
      goldroadInlineImages: [blob(CID_A)],
    };
    const record = updateDocumentRecord(existing, {
      title: "Illustrated",
      body: `${imageMarkdown(CID_A)}\n\n${imageMarkdown(CID_B)}`,
      inlineImageSources: [blob(CID_B)], // only the newly uploaded one
    });
    expect(record.goldroadInlineImages?.map((b) => b.ref.$link)).toEqual([
      CID_B,
      CID_A,
    ]);
  });

  it("an edit that removes an image drops its reference", () => {
    const record = updateDocumentRecord(
      {
        $type: "site.standard.document",
        title: "Illustrated",
        site: "https://example.com/@writer",
        path: "/3l",
        publishedAt: "2026-01-01T00:00:00.000Z",
        textContent: imageMarkdown(CID_A),
        goldroadInlineImages: [blob(CID_A)],
      },
      { title: "Illustrated", body: "The picture is gone." },
    );
    expect(record.goldroadInlineImages).toBeUndefined();
  });

  it("ignores a junk array on the existing record", () => {
    const record = updateDocumentRecord(
      {
        $type: "site.standard.document",
        title: "T",
        site: "https://example.com/@writer",
        path: "/3l",
        publishedAt: "2026-01-01T00:00:00.000Z",
        goldroadInlineImages: "not an array",
      },
      { title: "T", body: imageMarkdown(CID_A) },
    );
    expect(record.goldroadInlineImages).toBeUndefined();
  });
});

describe("foldImageFigures", () => {
  it("turns a captioned figure into markdown plus an italic caption line", () => {
    expect(
      foldImageFigures(
        '<figure><img src="/img/did/cid" alt="A cat"><figcaption>On the wall.</figcaption></figure>',
      ),
    ).toBe("![A cat](/img/did/cid)\n\n*On the wall.*");
  });

  it("keeps the image when there is no caption, and drops a caption that just repeats the alt text", () => {
    expect(
      foldImageFigures('<figure><img src="/a.png" alt="A cat"></figure>'),
    ).toBe("![A cat](/a.png)");
    expect(
      foldImageFigures(
        '<figure><img src="/a.png" alt="A cat"><figcaption>A cat</figcaption></figure>',
      ),
    ).toBe("![A cat](/a.png)");
  });

  it("decodes entities, strips caption markup, and angle-bracket-wraps an awkward URL", () => {
    expect(
      foldImageFigures(
        '<figure><img src="/a b(1).png" alt="Tom &amp; Jerry"><figcaption><em>Say &lt;hi&gt;</em></figcaption></figure>',
      ),
    ).toBe("![Tom & Jerry](</a b(1).png>)\n\n*Say <hi>*");
  });

  it("leaves a body with no figure — and a figure with no src — exactly as it found it", () => {
    const plain = "Just words with an ![image](/a.png).";
    expect(foldImageFigures(plain)).toBe(plain);
    const srcless = '<figure><img alt="nothing"></figure>';
    expect(foldImageFigures(srcless)).toBe(srcless);
  });

  it("is applied on the way into the record, so readers never get raw HTML", () => {
    const record = buildDocumentRecord({
      title: "Illustrated",
      site: "https://example.com/@writer",
      path: "/3l",
      body: '<figure><img src="/img/did/cid" alt="A cat"><figcaption>On the wall.</figcaption></figure>',
    });
    expect(record.textContent).toBe("![A cat](/img/did/cid)\n\n*On the wall.*");
  });
});
