import { describe, expect, it } from "vitest";

import {
  BLUESKY_POST_LIMIT,
  passageShareUrl,
  postShareUrl,
  tidyQuote,
  truncateGraphemes,
} from "#/lib/bluesky-share";

const URL_ = "https://trygoldroad.com/@writer.example/3lyk73wxnok2f";

/** The text a compose link fills in, decoded. */
function composed(href: string): string {
  const url = new URL(href);
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://bsky.app/intent/compose",
  );
  return url.searchParams.get("text") ?? "";
}

const graphemeCount = (text: string) =>
  Array.from(new Intl.Segmenter().segment(text)).length;

describe("postShareUrl", () => {
  it("fills Bluesky's composer with the title, a blank line and the link", () => {
    expect(composed(postShareUrl("On owning your words", URL_))).toBe(
      `On owning your words\n\n${URL_}`,
    );
  });

  it("shares just the link for an untitled post", () => {
    expect(composed(postShareUrl(undefined, URL_))).toBe(URL_);
    expect(composed(postShareUrl("   ", URL_))).toBe(URL_);
  });

  it("cuts a long title to fit the post limit and keeps the link whole", () => {
    const text = composed(postShareUrl("word ".repeat(100), URL_));
    expect(graphemeCount(text)).toBeLessThanOrEqual(BLUESKY_POST_LIMIT);
    expect(text.endsWith(`…\n\n${URL_}`)).toBe(true);
  });
});

describe("passageShareUrl", () => {
  it("quotes the passage, then links the post", () => {
    expect(composed(passageShareUrl("A line worth keeping.", URL_))).toBe(
      `“A line worth keeping.”\n\n${URL_}`,
    );
  });

  it("holds a long passage to 300 graphemes, quote marks and link included", () => {
    const text = composed(passageShareUrl("sentence ".repeat(80), URL_));
    expect(graphemeCount(text)).toBeLessThanOrEqual(BLUESKY_POST_LIMIT);
    expect(text.startsWith("“sentence")).toBe(true);
    expect(text.endsWith(`…”\n\n${URL_}`)).toBe(true);
  });

  it("counts graphemes, not code units, and never splits one", () => {
    // Each family emoji is one grapheme of eleven UTF-16 units.
    const family = "👨‍👩‍👧‍👦";
    const passage = family.repeat(400);
    const text = composed(passageShareUrl(passage, URL_));
    expect(graphemeCount(text)).toBe(BLUESKY_POST_LIMIT);
    const quote = text.slice(1, text.indexOf("…"));
    expect(quote).toBe(family.repeat(graphemeCount(quote)));
  });
});

describe("truncateGraphemes", () => {
  it("leaves text that fits alone", () => {
    expect(truncateGraphemes("short", 10)).toBe("short");
  });

  it("ends on a whole word when one is close", () => {
    const text = "Writers keep their readers when the address is theirs";
    expect(truncateGraphemes(text, 31)).toBe("Writers keep their readers…");
    expect(truncateGraphemes(text, 28)).toBe("Writers keep their readers…");
  });

  it("cuts mid-run when there is no space nearby", () => {
    expect(truncateGraphemes("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("tidyQuote", () => {
  it("collapses runs of spaces, and of blank lines between paragraphs", () => {
    expect(tidyQuote("  First\tline\n of it.\n\n\n\nNext  one. ")).toBe(
      "First line\nof it.\n\nNext one.",
    );
  });
});
