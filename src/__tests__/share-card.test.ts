// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * The share card: its place on the record, and the pure half of drawing it.
 *
 * The record rule these pin is the one every Goldroad-owned blob field keeps:
 * `goldroadShareCard` is rebuilt on every write, never inherited. A PDS serves
 * only blobs a record names and reclaims the rest, so an inherited card would
 * keep an old title in every link preview, and a dropped one is reclaimed.
 */
import {
  buildDocumentRecord,
  keptShareCard,
  SHARE_CARD_MIME,
  shareCardBlob,
  toRecordInput,
  updateDocumentRecord,
} from "../lib/publish";
import {
  blobCid,
  ellipsize,
  fitTitle,
  type Measure,
  mixOklab,
  shareCardColors,
  TITLE_STEPS,
  wrapWords,
} from "../lib/share-card";

const CID = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const card = (over: Record<string, unknown> = {}) => ({
  $type: "blob" as const,
  ref: { $link: CID },
  mimeType: SHARE_CARD_MIME,
  size: 61_234,
  ...over,
});
const base = {
  title: "Why I stopped counting subscribers",
  body: "Some words.",
  site: "at://did:plc:fake2222222222writer2222/site.standard.publication/3lyk73wxnok2f",
  path: "/3lyk73wxnok2g",
};

describe("goldroadShareCard on the record", () => {
  it("carries the card as a real blob ref, rebuilt to its four fields", () => {
    const record = buildDocumentRecord({
      ...base,
      shareCard: { ...card(), note: "not ours to store" } as never,
    });
    expect(record.goldroadShareCard).toEqual(card());
    // The field name is permanent public API.
    expect(Object.keys(toRecordInput(record))).toContain("goldroadShareCard");
  });

  it("survives the trip through the writer's repo and back", () => {
    const record = buildDocumentRecord({ ...base, shareCard: card() });
    const stored = JSON.parse(JSON.stringify(toRecordInput(record)));
    expect(shareCardBlob(stored.goldroadShareCard)).toEqual(card());
  });

  it("omits a card that isn't a raster blob within the cap", () => {
    for (const bad of [
      card({ mimeType: "image/svg+xml" }),
      card({ size: 1_000_001 }),
      card({ size: 0 }),
      { cid: CID, mimeType: SHARE_CARD_MIME },
      `${CID}`,
      null,
    ]) {
      const record = buildDocumentRecord({ ...base, shareCard: bad as never });
      expect(record.goldroadShareCard).toBeUndefined();
    }
  });

  it("replaces the card on an edit that drew a new one", () => {
    const edited = updateDocumentRecord(
      { ...base, goldroadShareCard: card() },
      { ...base, shareCard: card({ ref: { $link: OTHER } }) },
    );
    expect(edited.goldroadShareCard?.ref.$link).toBe(OTHER);
  });

  it("never inherits the card across an edit that didn't vouch for it", () => {
    const edited = updateDocumentRecord(
      { ...base, goldroadShareCard: card() },
      { ...base, title: "A new title" },
    );
    expect(edited.goldroadShareCard).toBeUndefined();
    expect("goldroadShareCard" in JSON.parse(JSON.stringify(edited))).toBe(
      false,
    );
  });

  it("keeps the existing card only for the exact CID the editor drew", () => {
    expect(keptShareCard(card(), CID)).toEqual(card());
    expect(keptShareCard(card(), OTHER)).toBeNull();
    expect(keptShareCard(card(), null)).toBeNull();
    expect(keptShareCard(card({ mimeType: "text/html" }), CID)).toBeNull();
    expect(keptShareCard(undefined, CID)).toBeNull();
  });
});

/** A monospace stand-in for `ctx.measureText`: every character is 0.5em. */
const mono: Measure = (text, size) => [...text].length * size * 0.5;

describe("fitting the title", () => {
  it("takes the largest size a short title fits at", () => {
    const fitted = fitTitle("Why I stopped counting subscribers", mono);
    expect(fitted.size).toBe(86);
    expect(fitted.lines.length).toBeLessThanOrEqual(3);
  });

  it("steps down until the title fits its line count", () => {
    // 24 characters a line at 86px, 3 lines: a 100-character title can't.
    const title = Array.from({ length: 20 }, () => "word").join(" ");
    const fitted = fitTitle(title, mono);
    expect(fitted.size).toBeLessThan(86);
    const step = TITLE_STEPS.find((s) => s.size === fitted.size);
    expect(fitted.lines.length).toBeLessThanOrEqual(step?.lines ?? 0);
    expect(fitted.lines.join(" ")).toBe(title);
  });

  it("clamps the longest titles to four lines ending in an ellipsis", () => {
    const fitted = fitTitle("an endless title ".repeat(60).trim(), mono);
    expect(fitted.size).toBe(50);
    expect(fitted.lines).toHaveLength(4);
    expect(fitted.lines[3].endsWith("…")).toBe(true);
    for (const line of fitted.lines)
      expect(mono(line, 50)).toBeLessThanOrEqual(1056);
  });

  it("breaks a word wider than the column, as a script without spaces needs", () => {
    const lines = wrapWords("字".repeat(60), 50, 1056, mono);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(mono(line, 50)).toBeLessThanOrEqual(1056);
    expect(lines.join("")).toBe("字".repeat(60));
  });

  it("ellipsises a label only when it overflows, at a word when it can", () => {
    expect(ellipsize("The Long Table", 26, 1056, mono)).toBe("The Long Table");
    const cut = ellipsize("word ".repeat(100).trim(), 26, 300, mono);
    expect(cut).toMatch(/word…$/);
    expect(mono(cut, 26)).toBeLessThanOrEqual(300);
  });
});

describe("the card's colours", () => {
  it("gives an unthemed writer the unthemed page's vermillion", () => {
    expect(shareCardColors(null)).toEqual({
      background: "rgb(255 255 255)",
      foreground: "rgb(22 22 22)",
      accent: "rgb(197 47 15)",
      rule: expect.any(String),
    });
  });

  it("mixes the rule 20% foreground into background, in oklab", () => {
    // oklab L 0.8 between black and white is sRGB grey 189.
    const grey = mixOklab(
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      0.2,
    );
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
    expect(Math.abs(grey.r - 189)).toBeLessThanOrEqual(1);
  });
});

describe("blobCid", () => {
  it("names bytes the way a PDS names the blob", async () => {
    // The CIDv1 (raw, sha2-256) of zero bytes, a fixed point of the format.
    expect(await blobCid(new ArrayBuffer(0))).toBe(
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
  });
});
