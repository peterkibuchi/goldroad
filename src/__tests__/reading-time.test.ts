// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  documentReadingMinutes,
  formatReadingTime,
  listItemReadingMinutes,
  readingTimeMinutes,
} from "../lib/reading-time";

describe("readingTimeMinutes", () => {
  it("rounds UP — honest rounding never undersells the piece", () => {
    // 226 words at the 225 wpm default is just over one minute.
    const words = Array.from({ length: 226 }, () => "word").join(" ");
    expect(readingTimeMinutes(words)).toBe(2);
  });

  it("never reports zero minutes for any non-empty body", () => {
    expect(readingTimeMinutes("one two three")).toBe(1);
  });

  it("reports zero for an empty body", () => {
    expect(readingTimeMinutes("")).toBe(0);
    expect(formatReadingTime(readingTimeMinutes(""))).toBeNull();
  });

  it("strips markdown syntax before counting words", () => {
    // Markup characters shouldn't inflate the count beyond the prose words.
    const markdown =
      "# Heading\n\n**bold** and _italic_ and `code` and a [link](https://example.com).";
    // "Heading bold and italic and code and a link ." → 9 words after strip.
    expect(readingTimeMinutes(markdown, undefined, 1000)).toBe(1);
  });

  it("honors a custom words-per-minute rate", () => {
    const words = Array.from({ length: 100 }, () => "word").join(" ");
    expect(readingTimeMinutes(words, undefined, 100)).toBe(1);
    expect(readingTimeMinutes(words, undefined, 50)).toBe(2);
  });
});

describe("formatReadingTime", () => {
  it("formats a positive minute count", () => {
    expect(formatReadingTime(3)).toBe("3 min read");
    expect(formatReadingTime(1)).toBe("1 min read");
  });

  it("returns null for zero or negative minutes", () => {
    expect(formatReadingTime(0)).toBeNull();
  });
});

describe("documentReadingMinutes vs listItemReadingMinutes — scan-window budgets", () => {
  it("both agree on a short post (well within either scan window)", () => {
    const words = Array.from({ length: 300 }, () => "word").join(" ");
    expect(documentReadingMinutes(words)).toBe(listItemReadingMinutes(words));
  });

  it("the list's bounded scan can undercount a very long post that the single-document scan reads in full", () => {
    // ~4000 words: past the list's default ~2048-char scan window, well
    // within the document page's much larger single-record budget.
    const words = Array.from({ length: 4000 }, () => "word").join(" ");
    const full = documentReadingMinutes(words);
    const bounded = listItemReadingMinutes(words);
    expect(full).toBeGreaterThan(bounded);
  });
});
