// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  AUTO_ANNOUNCE_MAX_BACKDATE_MS,
  autoAnnounceSkip,
  buildAnnouncePost,
  hasAnnouncement,
  NEVER_ANNOUNCE,
  truncateGraphemes,
  utf8Length,
} from "../lib/announce";

const URL = "https://goldroad.example/@writer.example/3lyk73wxnok2f";

/** The facet must cover exactly the URL, measured in UTF-8 bytes. */
function facetSlice(post: ReturnType<typeof buildAnnouncePost>): string {
  const { byteStart, byteEnd } = post.facets[0].index;
  const bytes = new TextEncoder().encode(post.text);
  return new TextDecoder().decode(bytes.slice(byteStart, byteEnd));
}

describe("buildAnnouncePost — facet byte offsets", () => {
  it("covers the URL exactly for an ASCII title", () => {
    const post = buildAnnouncePost({ title: "Hello Atmosphere", url: URL });
    expect(post.text).toBe(`Hello Atmosphere\n${URL}`);
    expect(facetSlice(post)).toBe(URL);
    expect(post.facets[0].features[0]).toEqual({
      $type: "app.bsky.richtext.facet#link",
      uri: URL,
    });
  });

  it("uses UTF-8 byte offsets, not UTF-16 char offsets (emoji title)", () => {
    // "🔥" is 1 grapheme, 2 UTF-16 code units, 4 UTF-8 bytes — char-offset
    // math would land the facet 2 bytes short.
    const post = buildAnnouncePost({ title: "🔥 hot take 🔥", url: URL });
    expect(facetSlice(post)).toBe(URL);
    expect(post.facets[0].index.byteStart).toBe(
      utf8Length("🔥 hot take 🔥") + 1,
    );
  });

  it("handles multibyte non-emoji titles (accents, CJK)", () => {
    for (const title of ["Ceci n'est pas une pipe — déjà vu", "日本語の記事"]) {
      const post = buildAnnouncePost({ title, url: URL });
      expect(facetSlice(post)).toBe(URL);
    }
  });

  it("byteEnd equals the text's total byte length (URL is the suffix)", () => {
    const post = buildAnnouncePost({ title: "简体中文 🚀", url: URL });
    expect(post.facets[0].index.byteEnd).toBe(utf8Length(post.text));
  });
});

describe("buildAnnouncePost — text limits", () => {
  it("truncates a >300-grapheme title but never the URL", () => {
    const post = buildAnnouncePost({ title: "long ".repeat(100), url: URL });
    const graphemes = [...new Intl.Segmenter().segment(post.text)].length;
    expect(graphemes).toBeLessThanOrEqual(300);
    expect(post.text.endsWith(URL)).toBe(true);
    expect(facetSlice(post)).toBe(URL);
  });

  it("truncates on grapheme boundaries — never splits an emoji", () => {
    const post = buildAnnouncePost({ title: "👩‍🚀".repeat(300), url: URL });
    expect(post.text).not.toContain("�");
    // A trailing complete astronaut before the ellipsis, not a broken surrogate.
    expect(facetSlice(post)).toBe(URL);
  });

  it("posts the bare URL when the title is empty", () => {
    const post = buildAnnouncePost({ title: "  ", url: URL });
    expect(post.text).toBe(URL);
    expect(post.facets[0].index.byteStart).toBe(0);
  });
});

describe("buildAnnouncePost — record shape", () => {
  it("shapes the app.bsky.embed.external with associatedRefs strongRefs", () => {
    const refs = [
      {
        uri: "at://did:plc:fakefakefakefakefakefake/site.standard.document/3lyk73wxnok2f",
        cid: "bafyreib-canary-not-a-real-cid",
      },
    ];
    const post = buildAnnouncePost({
      title: "T",
      url: URL,
      description: "A description.",
      associatedRefs: refs,
      createdAt: new Date("2026-07-23T00:00:00Z"),
    });
    expect(post.$type).toBe("app.bsky.feed.post");
    expect(post.embed).toEqual({
      $type: "app.bsky.embed.external",
      external: {
        uri: URL,
        title: "T",
        description: "A description.",
        associatedRefs: refs,
      },
    });
    expect(post.createdAt).toBe("2026-07-23T00:00:00.000Z");
  });

  it("omits associatedRefs when none resolve, keeps description lexicon-legal", () => {
    const post = buildAnnouncePost({ title: "T", url: URL });
    expect(post.embed.external.associatedRefs).toBeUndefined();
    expect(post.embed.external.description).toBe(""); // required field, may be empty
  });

  it("carries the cover blob as the card thumb when given, omits it otherwise", () => {
    const thumb = {
      $type: "blob" as const,
      ref: { $link: "bafkreicanarycovercid000000000000000000000" },
      mimeType: "image/jpeg",
      size: 4096,
    };
    expect(
      buildAnnouncePost({ title: "T", url: URL, thumb }).embed.external.thumb,
    ).toEqual(thumb);
    expect(
      buildAnnouncePost({ title: "T", url: URL }).embed.external.thumb,
    ).toBeUndefined();
  });

  it("keeps the full title on the card even when the text was truncated", () => {
    const title = "t".repeat(400);
    const post = buildAnnouncePost({ title, url: URL });
    expect(post.embed.external.title).toBe(title);
    expect(post.text.length).toBeLessThan(400);
  });
});

describe("truncateGraphemes", () => {
  it("returns short strings unchanged", () => {
    expect(truncateGraphemes("abc", 5)).toBe("abc");
  });
  it("adds an ellipsis within the budget", () => {
    const out = truncateGraphemes("abcdef", 4);
    expect(out).toBe("abc…");
  });
  it("counts a ZWJ emoji sequence as one grapheme", () => {
    expect(truncateGraphemes("👩‍🚀👩‍🚀👩‍🚀", 3)).toBe("👩‍🚀👩‍🚀👩‍🚀");
  });
});

/**
 * The auto-announce policy: what a publish is allowed to post on a writer's
 * behalf, decided in one pure function so all three publish paths get the same
 * answer.
 *
 * The order of the checks is part of the contract, not an implementation detail:
 * "the writer said no" must be answered before anything costs a query, and
 * "this is under a takedown" must be answered before anything reaches Bluesky.
 */
describe("autoAnnounceSkip", () => {
  const NOW = Date.parse("2026-08-17T09:00:00.000Z");
  const base = { requested: true, imported: false, hidden: false, now: NOW };

  it("lets an ordinary first publish through", () => {
    expect(
      autoAnnounceSkip({ ...base, publishedAt: new Date(NOW) }),
    ).toBeNull();
  });

  it("answers the writer's own decision first, and by name", () => {
    expect(autoAnnounceSkip({ ...base, requested: false })).toBe(
      "not_requested",
    );
    // Even when every other reason to refuse also applies: the reason reported
    // is the one that costs nothing to find out.
    expect(
      autoAnnounceSkip({
        ...base,
        requested: false,
        imported: true,
        hidden: true,
      }),
    ).toBe("not_requested");
  });

  it("refuses an imported post — an archive is not an announcement", () => {
    expect(autoAnnounceSkip({ ...base, imported: true })).toBe("imported");
  });

  it("refuses a taken-down subject before anything else about the post", () => {
    expect(autoAnnounceSkip({ ...base, hidden: true })).toBe("taken_down");
    // Ahead of the backdate check, so a takedown is never reported as a stale
    // date — an operator reading the log line needs the real reason.
    expect(
      autoAnnounceSkip({
        ...base,
        hidden: true,
        publishedAt: new Date(NOW - AUTO_ANNOUNCE_MAX_BACKDATE_MS - 1),
      }),
    ).toBe("taken_down");
  });

  it("refuses a backdated post — the second net under a flaked ledger read", () => {
    // A post published now carries a publishedAt of now. The only way to be a
    // day out is to have been backdated deliberately, which is what importing an
    // archive does — and the import-ledger check that normally catches it is a
    // best-effort D1 read.
    expect(
      autoAnnounceSkip({
        ...base,
        publishedAt: new Date(NOW - AUTO_ANNOUNCE_MAX_BACKDATE_MS - 1),
      }),
    ).toBe("backdated");
  });

  it("does not refuse a post inside the window, or one with no date at all", () => {
    expect(
      autoAnnounceSkip({
        ...base,
        publishedAt: new Date(NOW - AUTO_ANNOUNCE_MAX_BACKDATE_MS + 1000),
      }),
    ).toBeNull();
    expect(autoAnnounceSkip({ ...base, publishedAt: null })).toBeNull();
    // An unparseable date must not be read as 1970 and refused, nor as now and
    // waved through on a NaN comparison.
    expect(
      autoAnnounceSkip({ ...base, publishedAt: new Date("nonsense") }),
    ).toBeNull();
  });

  it("does not refuse a post dated slightly in the future", () => {
    // Clock skew between a writer's browser and a PDS is real and small.
    expect(
      autoAnnounceSkip({ ...base, publishedAt: new Date(NOW + 60_000) }),
    ).toBeNull();
  });
});

describe("NEVER_ANNOUNCE", () => {
  it("is what a bulk caller passes, and it means no", () => {
    // Exported as a constant so a future bulk path has an obvious right answer
    // — and `announce` is a REQUIRED argument on the publish core precisely so
    // such a path cannot compile without choosing one.
    expect(NEVER_ANNOUNCE.requested).toBe(false);
    expect(
      autoAnnounceSkip({
        ...NEVER_ANNOUNCE,
        imported: false,
        hidden: false,
        now: Date.now(),
      }),
    ).toBe("not_requested");
  });
});

describe("hasAnnouncement", () => {
  it("reads any bskyPostRef as 'already announced'", () => {
    // Untrusted shape: any app may have written this field. The question is
    // whether somebody announced, not whether we can parse what they wrote.
    expect(
      hasAnnouncement({ bskyPostRef: { uri: "at://x/y/z", cid: "c" } }),
    ).toBe(true);
    expect(hasAnnouncement({ bskyPostRef: "at://x/y/z" })).toBe(true);
    expect(hasAnnouncement({ bskyPostRef: {} })).toBe(true);
  });

  it("reads absence as never announced", () => {
    expect(hasAnnouncement({})).toBe(false);
    expect(hasAnnouncement({ bskyPostRef: undefined })).toBe(false);
    expect(hasAnnouncement({ bskyPostRef: null })).toBe(false);
    // An empty string is a field somebody cleared, not a post.
    expect(hasAnnouncement({ bskyPostRef: "" })).toBe(false);
  });
});
