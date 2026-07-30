// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

/**
 * Medium export-zip parsing, against synthetic archives built in-test
 * (fflate zips as well as it unzips — same technique as import-zip.test.ts).
 * Pins the filename contract (date-prefixed published posts, draft_-prefixed
 * drafts), the canonical-link response/comment heuristic (excludes only on a
 * specific positive signal, never on absence of one), and the zip-bomb
 * defenses shared with the Substack path via ~/lib/zip-safety.
 */
import {
  ExportTooComplexError,
  mediumPostGuid,
  parseMediumExport,
} from "../lib/import-medium";
import { MAX_ENTRY_BYTES, MAX_ZIP_ENTRIES } from "../lib/import-zip";

const LONG_HTML = (canonical: string) =>
  `<html><head><title>A real post</title><link rel="canonical" href="${canonical}"></head><body>${`<p>${"substantial words ".repeat(40)}</p>`.repeat(3)}</body></html>`;
const STUB_HTML = `<html><body><p>Short stub.</p></body></html>`;

function exportZip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        [strToU8(text), { level: 6 }] as [Uint8Array, { level: 6 }],
      ]),
    ),
  );
}

describe("parseMediumExport — happy path", () => {
  it("reads a published post: date prefix, hex id, self-referential canonical", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-03-01_first-post-a1b2c3d4e5f6.html": LONG_HTML(
          "https://medium.com/@writer/first-post-a1b2c3d4e5f6",
        ),
      }),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].fileSlug).toBe("2024-03-01_first-post-a1b2c3d4e5f6");
    expect(parsed.posts[0].title).toBe("A real post");
    expect(parsed.posts[0].publishedAt).toBe("2024-03-01T00:00:00.000Z");
    expect(parsed.posts[0].publishedAtSource).toBe(true);
    expect(parsed.posts[0].link).toBe(
      "https://medium.com/@writer/first-post-a1b2c3d4e5f6",
    );
  });

  it("drops a canonical link that isn't https", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-03-01_first-post-a1b2c3d4e5f6.html": LONG_HTML(
          "http://medium.com/@writer/first-post-a1b2c3d4e5f6",
        ),
      }),
    );
    expect(parsed.posts[0].link).toBeNull();
  });

  it("reads a draft: draft_ prefix, no date", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/draft_my-draft-a1b2c3d4e5f6.html": LONG_HTML(""),
      }),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].publishedAt).toBeNull();
    expect(parsed.posts[0].publishedAtSource).toBe(false);
  });

  it("falls back to a filename-derived title when there is no <title>", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-03-01_a-real-post-a1b2c3d4e5f6.html": STUB_HTML,
      }),
    );
    expect(parsed.posts[0].title).toBe("A real post");
  });

  it("accepts archives nested one folder deep", () => {
    const parsed = parseMediumExport(
      exportZip({
        "medium-export/posts/2024-03-01_first-post-a1b2c3d4e5f6.html":
          LONG_HTML(""),
      }),
    );
    expect(parsed.posts).toHaveLength(1);
  });

  it("ignores macOS resource-fork noise", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-03-01_first-post-a1b2c3d4e5f6.html": LONG_HTML(""),
        "__MACOSX/posts/._2024-03-01_first-post-a1b2c3d4e5f6.html": "junk",
      }),
    );
    expect(parsed.posts).toHaveLength(1);
  });
});

describe("parseMediumExport — response/comment exclusion", () => {
  it("excludes a file whose canonical link points at a DIFFERENT post id", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-03-01_a-reply-a1b2c3d4e5f6.html": LONG_HTML(
          "https://medium.com/@someone-else/their-post-f6e5d4c3b2a1",
        ),
      }),
    );
    expect(parsed.posts).toEqual([]);
    expect(parsed.skippedResponses).toBe(1);
  });

  it("keeps a file with NO canonical link — ambiguous never means excluded", () => {
    const parsed = parseMediumExport(
      exportZip({ "posts/2024-03-01_first-post-a1b2c3d4e5f6.html": STUB_HTML }),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.skippedResponses).toBe(0);
  });

  it("keeps a file whose canonical link is on a different (non-medium.com) host", () => {
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-03-01_first-post-a1b2c3d4e5f6.html": LONG_HTML(
          "https://blog.example.com/somewhere-else",
        ),
      }),
    );
    expect(parsed.posts).toHaveLength(1);
  });
});

describe("parseMediumExport — defensive paths", () => {
  it("a corrupt entry costs that post alone, never the archive", () => {
    const good = "posts/2024-01-01_good-a1b2c3d4e5f6.html";
    const bad = "posts/2024-02-02_bad-f6e5d4c3b2a1.html";
    const zip = exportZip({ [good]: LONG_HTML(""), [bad]: LONG_HTML("") });
    // Corrupt the second entry's deflate stream the same way import-zip's
    // fixture does: guaranteed-invalid bytes right after its local header.
    const bytes = zip.slice();
    const target = strToU8(bad);
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x03 &&
        bytes[i + 3] === 0x04
      ) {
        const nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
        const extraLen = bytes[i + 28] | (bytes[i + 29] << 8);
        const nameStart = i + 30;
        if (
          nameLen === target.length &&
          target.every((b, j) => bytes[nameStart + j] === b)
        ) {
          bytes.fill(
            0xff,
            nameStart + nameLen + extraLen,
            nameStart + nameLen + extraLen + 8,
          );
          break;
        }
      }
    }
    const parsed = parseMediumExport(bytes);
    expect(parsed.posts.map((p) => p.fileSlug)).toEqual([
      "2024-01-01_good-a1b2c3d4e5f6",
    ]);
    expect(parsed.failures).toEqual([{ name: bad, reason: "corrupt" }]);
  });

  it("refuses an entry whose inflated size crosses the cap", () => {
    const oversize = "x".repeat(MAX_ENTRY_BYTES + 1);
    const parsed = parseMediumExport(
      exportZip({
        "posts/2024-01-01_good-a1b2c3d4e5f6.html": LONG_HTML(""),
        "posts/2024-02-02_bad-f6e5d4c3b2a1.html": oversize,
      }),
    );
    expect(parsed.posts.map((p) => p.fileSlug)).toEqual([
      "2024-01-01_good-a1b2c3d4e5f6",
    ]);
    expect(parsed.failures).toEqual([
      { name: "posts/2024-02-02_bad-f6e5d4c3b2a1.html", reason: "too_large" },
    ]);
  });

  it("throws on bytes that aren't a zip at all", () => {
    expect(() => parseMediumExport(strToU8("not an archive"))).toThrow();
  });

  it("refuses entry-count floods before reading anything", () => {
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i++) {
      files[`junk/${i}`] = [new Uint8Array(0), { level: 0 }];
    }
    expect(() => parseMediumExport(zipSync(files))).toThrow(
      ExportTooComplexError,
    );
  });

  it(`caps archives past MAX_EXPORT_POSTS BEFORE inflating them, and says so`, async () => {
    const { MAX_EXPORT_POSTS } = await import("../lib/import");
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_EXPORT_POSTS + 5; i++) {
      files[`posts/2024-01-01_post-${i}-a1b2c3d4e5f6.html`] = LONG_HTML("");
    }
    const parsed = parseMediumExport(exportZip(files));
    expect(parsed.posts).toHaveLength(MAX_EXPORT_POSTS);
    expect(parsed.truncated).toBe(5);
    // Deflating 1005 long documents is the point of this fixture, not overhead
    // to optimise away: if the cap ever regressed into inflating everything,
    // that is what would catch it. The work costs ~2.5s idle and several times
    // that on a busy box, so the 5s default leaves too little headroom.
  }, 30_000);
});

describe("identity helper", () => {
  it("namespaces export guids so re-uploads dedupe and other sources can't collide", () => {
    expect(mediumPostGuid("2024-03-01_first-post-a1b2c3d4e5f6")).toBe(
      "medium-export:2024-03-01_first-post-a1b2c3d4e5f6",
    );
  });
});
