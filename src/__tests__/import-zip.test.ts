// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

/**
 * The Substack export-zip parser, against synthetic archives built in-test
 * (fflate zips as well as it unzips). Pins the format contract — posts.csv
 * metadata decorating posts/<id>.<slug>.html files — and every defensive
 * property: CSV-less fallback, per-entry corruption isolation, oversize
 * refusal (declared AND actual), macOS noise filtering, archive-cap
 * truncation, and the paywall-stub flag.
 */
import {
  constructSourceUrl,
  ExportTooComplexError,
  MAX_ENTRY_BYTES,
  MAX_EXPORT_POSTS,
  MAX_ZIP_ENTRIES,
  normalizeHost,
  parseCsv,
  parsePostsCsv,
  parseSubstackExport,
  zipPostGuid,
} from "../lib/import-zip";

const LONG_HTML = `<h2>A real post</h2>${`<p>${"substantial words ".repeat(40)}</p>`.repeat(3)}`;
const STUB_HTML = `<p>This post is for paid subscribers.</p>`;

const CSV = [
  "post_id,post_date,is_published,type,audience,title,subtitle",
  '101.first-post,2024-03-01T10:00:00.000Z,true,newsletter,everyone,"First, comma title",sub',
  "102.second-post,2024-05-02T10:00:00.000Z,false,newsletter,only_paid,Second post,",
].join("\n");

function exportZip(
  files: Record<string, string> = {
    "posts.csv": CSV,
    "posts/101.first-post.html": LONG_HTML,
    "posts/102.second-post.html": LONG_HTML,
  },
): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        [strToU8(text), { level: 6 }] as [Uint8Array, { level: 6 }],
      ]),
    ),
  );
}

/** Overwrites the start of one entry's deflate stream with reserved-block-type
 * bytes (0xff) — guaranteed-invalid DEFLATE, so inflating THAT entry throws
 * while every other entry stays readable. */
function corruptEntry(zip: Uint8Array, name: string): Uint8Array {
  const bytes = zip.slice();
  const target = strToU8(name);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] !== 0x50 ||
      bytes[i + 1] !== 0x4b ||
      bytes[i + 2] !== 0x03 ||
      bytes[i + 3] !== 0x04
    )
      continue;
    const nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
    const extraLen = bytes[i + 28] | (bytes[i + 29] << 8);
    if (nameLen !== target.length) continue;
    const nameStart = i + 30;
    if (!target.every((b, j) => bytes[nameStart + j] === b)) continue;
    bytes.fill(
      0xff,
      nameStart + nameLen + extraLen,
      nameStart + nameLen + extraLen + 8,
    );
    return bytes;
  }
  throw new Error(`entry not found in fixture: ${name}`);
}

describe("parseSubstackExport — happy path", () => {
  it("drives from the HTML files and decorates from the CSV", () => {
    const parsed = parseSubstackExport(exportZip());
    expect(parsed.csvFound).toBe(true);
    expect(parsed.failures).toEqual([]);
    expect(parsed.posts).toHaveLength(2);
    // Newest first: 102 (May) before 101 (March).
    expect(parsed.posts[0].postId).toBe("102.second-post");
    expect(parsed.posts[0].slug).toBe("second-post");
    expect(parsed.posts[0].title).toBe("Second post");
    expect(parsed.posts[0].publishedAt).toBe("2024-05-02T10:00:00.000Z");
    expect(parsed.posts[0].publishedAtSource).toBe(false); // a Substack draft
    // Quoted CSV field with a comma survives intact.
    expect(parsed.posts[1].title).toBe("First, comma title");
    expect(parsed.posts[1].publishedAtSource).toBe(true);
    expect(parsed.posts[1].contentHtml).toContain("substantial words");
  });

  it("accepts archives nested one folder deep (how some exports unzip–rezip)", () => {
    const parsed = parseSubstackExport(
      exportZip({
        "my-export/posts.csv": CSV,
        "my-export/posts/101.first-post.html": LONG_HTML,
      }),
    );
    expect(parsed.csvFound).toBe(true);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].title).toBe("First, comma title");
  });

  it("ignores macOS resource-fork noise and duplicate post ids", () => {
    const parsed = parseSubstackExport(
      exportZip({
        "posts.csv": CSV,
        "posts/101.first-post.html": LONG_HTML,
        "__MACOSX/posts/._101.first-post.html": "\x00\x05junk",
        "posts/._102.second-post.html": "\x00\x05junk",
        "extra/posts/101.first-post.html": LONG_HTML, // duplicate id
      }),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].postId).toBe("101.first-post");
  });
});

describe("parseSubstackExport — defensive paths", () => {
  it("missing csv → filename-derived titles, unknown dates and status", () => {
    const parsed = parseSubstackExport(
      exportZip({ "posts/101.first-post.html": LONG_HTML }),
    );
    expect(parsed.csvFound).toBe(false);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].title).toBe("First post");
    expect(parsed.posts[0].publishedAt).toBeNull();
    expect(parsed.posts[0].publishedAtSource).toBeNull();
  });

  it("a corrupt entry costs that post alone, never the archive", () => {
    const zip = corruptEntry(exportZip(), "posts/102.second-post.html");
    const parsed = parseSubstackExport(zip);
    expect(parsed.posts.map((p) => p.postId)).toEqual(["101.first-post"]);
    expect(parsed.failures).toEqual([
      { name: "posts/102.second-post.html", reason: "corrupt" },
    ]);
  });

  it("refuses an entry whose inflated size crosses the cap — declared honestly per item", () => {
    const oversize = "x".repeat(MAX_ENTRY_BYTES + 1);
    const parsed = parseSubstackExport(
      exportZip({
        "posts.csv": CSV,
        "posts/101.first-post.html": LONG_HTML,
        "posts/102.second-post.html": oversize,
      }),
    );
    expect(parsed.posts.map((p) => p.postId)).toEqual(["101.first-post"]);
    expect(parsed.failures).toEqual([
      { name: "posts/102.second-post.html", reason: "too_large" },
    ]);
  });

  it("throws on bytes that aren't a zip at all (the page's zip_unreadable)", () => {
    expect(() => parseSubstackExport(strToU8("this is no archive"))).toThrow();
  });

  it("flags teaser-length HTML as a possible paywall stub", () => {
    const parsed = parseSubstackExport(
      exportZip({
        "posts.csv": CSV,
        "posts/101.first-post.html": LONG_HTML,
        "posts/102.second-post.html": STUB_HTML,
      }),
    );
    const stub = parsed.posts.find((p) => p.postId === "102.second-post");
    const real = parsed.posts.find((p) => p.postId === "101.first-post");
    expect(stub?.preview).toBe(true);
    expect(real?.preview).toBe(false);
  });

  it(`cuts archives past ${MAX_EXPORT_POSTS} posts BEFORE inflating them, and says so`, () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_EXPORT_POSTS + 5; i++) {
      files[`posts/${1000 + i}.post-${i}.html`] = LONG_HTML;
    }
    const parsed = parseSubstackExport(exportZip(files));
    expect(parsed.posts).toHaveLength(MAX_EXPORT_POSTS);
    expect(parsed.truncated).toBe(5);
    // The cap keeps the archive's first entries (never inflating the rest);
    // no dates (no csv) → numeric-id descending sorts what was read.
    expect(parsed.posts[0].postId).toBe(
      `${1000 + MAX_EXPORT_POSTS - 1}.post-${MAX_EXPORT_POSTS - 1}`,
    );
  });

  it("refuses entry-count floods before reading anything (quadratic-parse guard)", () => {
    // Empty entries pass every byte cap; only the entry-count ceiling stops
    // an archive built to make the per-entry directory walk quadratic.
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i++) {
      files[`junk/${i}`] = [new Uint8Array(0), { level: 0 }];
    }
    expect(() => parseSubstackExport(zipSync(files))).toThrow(
      ExportTooComplexError,
    );
  });
});

describe("csv parsing", () => {
  it("handles quotes, escaped quotes, and newlines inside quotes", () => {
    const rows = parseCsv('a,"b ""quoted"", still b","line\nbreak"\r\nc,d,e');
    expect(rows).toEqual([
      ["a", 'b "quoted", still b', "line\nbreak"],
      ["c", "d", "e"],
    ]);
  });

  it("is header-driven: reordered columns still map, missing post_id means no csv", () => {
    const reordered = parsePostsCsv(
      "title,is_published,post_id\nHello,true,7.hello",
    );
    expect(reordered?.get("7.hello")).toEqual({
      title: "Hello",
      publishedAt: null,
      isPublished: true,
    });
    expect(parsePostsCsv("a,b,c\n1,2,3")).toBeNull();
  });
});

describe("identity + provenance helpers", () => {
  it("namespaces export guids so re-uploads dedupe and feeds can't collide", () => {
    expect(zipPostGuid("101.first-post")).toBe(
      "substack-export:101.first-post",
    );
  });

  it("normalizes hostname-shaped input and refuses everything else", () => {
    expect(normalizeHost(" You.Substack.com ")).toBe("you.substack.com");
    expect(normalizeHost("https://you.substack.com/about")).toBe(
      "you.substack.com",
    );
    for (const junk of ["", "not a host!", "no-dots", "-bad.example", "a..b"]) {
      expect(normalizeHost(junk)).toBeNull();
    }
  });

  it("builds https provenance URLs only from clean host + slug", () => {
    expect(constructSourceUrl("you.substack.com", "first-post")).toBe(
      "https://you.substack.com/p/first-post",
    );
    expect(constructSourceUrl(null, "first-post")).toBeNull();
    expect(constructSourceUrl("you.substack.com", "")).toBeNull();
    expect(constructSourceUrl("you.substack.com", "a/../b")).toBeNull();
    expect(constructSourceUrl("you.substack.com", "a?b=c")).toBeNull();
  });
});
