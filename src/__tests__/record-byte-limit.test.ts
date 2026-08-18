import { describe, expect, it } from "vitest";

import {
  buildDocumentRecord,
  documentRecordByteLength,
  isOverRecordByteLimit,
  jsonByteLength,
  MAX_BODY_LENGTH,
  MAX_RECORD_BYTES,
  updateDocumentRecord,
} from "../lib/publish";

/**
 * The gap between the two limits, pinned.
 *
 * `MAX_BODY_LENGTH` counts UTF-16 code units and is the only thing anything
 * checked. A PDS counts the bytes of the JSON it stores — and the body goes in
 * twice (markdown in the content union, plaintext in `textContent`), so even
 * ASCII prose weighs about double its character count before a single accent
 * is typed. Every case below is a post the character cap ADMITS and a data
 * server refuses with a 413 the writer cannot act on.
 */

const SITE =
  "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/site.standard.publication/3lyk7wxnok2fb";
const PATH = "/3lyk7wxnok2fb";

describe("record byte limit — the character cap admits records a PDS refuses", () => {
  it("counts bytes of serialized JSON, not characters", () => {
    // Three bytes each in UTF-8, one JSON character each, plus the quotes.
    expect(jsonByteLength("字字字")).toBe(11);
    expect(jsonByteLength("abc")).toBe(5);
  });

  it("refuses an ASCII post that passes the character cap", () => {
    // Half the character budget — and the body is stored twice, so the record
    // lands around 160 KB against a 140 KB ceiling.
    const body = "x".repeat(80_000);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);

    const record = buildDocumentRecord({
      title: "A long essay",
      body,
      site: SITE,
      path: PATH,
    });
    expect(jsonByteLength(record)).toBeGreaterThan(MAX_RECORD_BYTES);
    expect(isOverRecordByteLimit(record)).toBe(true);
  });

  it("refuses a CJK post at a quarter of the character cap", () => {
    // Three bytes per character, written twice: ~150 KB from 25,000
    // characters, which is a short essay in Chinese or Japanese.
    const body = "字".repeat(25_000);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);

    const record = buildDocumentRecord({
      title: "随筆",
      body,
      site: SITE,
      path: PATH,
    });
    expect(isOverRecordByteLimit(record)).toBe(true);
  });

  it("admits a post that fits, so the guard is not simply always on", () => {
    const record = buildDocumentRecord({
      title: "An ordinary post",
      body: "word ".repeat(2_000),
      site: SITE,
      path: PATH,
    });
    expect(isOverRecordByteLimit(record)).toBe(false);
  });

  it("measures an EDIT on the merged record, extra fields and all", () => {
    // An edit inherits whatever the record already carried (tags, the announce
    // write-back's bskyPostRef, another app's fields). Measuring the body alone
    // would miss exactly the case where a record only just fit before.
    const existing = {
      $type: "site.standard.document" as const,
      title: "Old",
      site: SITE as `${string}:${string}`,
      path: PATH,
      publishedAt: "2026-01-01T00:00:00.000Z",
      tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`),
    };
    const merged = updateDocumentRecord(existing, {
      title: "New",
      body: "x".repeat(80_000),
    });
    expect(isOverRecordByteLimit(merged)).toBe(true);
  });
});

describe("documentRecordByteLength — the measurement the editor makes", () => {
  it("reports a size the real record can never exceed", () => {
    const body = "The quick brown fox. ".repeat(500);
    const measured = documentRecordByteLength({ title: "Foxes", body });
    const real = jsonByteLength(
      buildDocumentRecord({ title: "Foxes", body, site: SITE, path: PATH }),
    );
    // The placeholders stand in at the longest shape this app ever mints, so a
    // pre-publish measurement is an upper bound, never an underestimate.
    expect(measured).toBeGreaterThanOrEqual(real);
  });

  it("crosses the limit on a body the character cap admits", () => {
    expect(
      documentRecordByteLength({
        title: "A long essay",
        body: "x".repeat(80_000),
      }),
    ).toBeGreaterThan(MAX_RECORD_BYTES);
  });

  it("stays under it on an ordinary post", () => {
    expect(
      documentRecordByteLength({ title: "Hello", body: "word ".repeat(2_000) }),
    ).toBeLessThan(MAX_RECORD_BYTES);
  });

  it("counts the inline-image references the body still uses", () => {
    const cid = "bafkreiabcdefghijklmnopqrstuvwxyz234567";
    const blob = {
      $type: "blob",
      ref: { $link: cid },
      mimeType: "image/png",
      size: 1234,
    };
    const body = `text ![a](/img/did%3Aplc%3Aabc/${cid}) text`;
    const withImage = documentRecordByteLength({
      title: "Illustrated",
      body,
      inlineImageSources: [blob],
    });
    const without = documentRecordByteLength({ title: "Illustrated", body });
    expect(withImage).toBeGreaterThan(without);
  });

  it("reports nothing for a record that cannot be built at all", () => {
    // An empty title is a different refusal with its own message; answering
    // "too large" here would send the writer hunting for words to cut.
    expect(documentRecordByteLength({ title: "  ", body: "hello" })).toBe(0);
    expect(
      documentRecordByteLength({
        title: "Fine",
        body: "x".repeat(MAX_BODY_LENGTH + 1),
      }),
    ).toBe(0);
  });
});
