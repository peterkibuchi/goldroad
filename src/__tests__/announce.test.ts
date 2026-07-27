// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildAnnouncePost,
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
