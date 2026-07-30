// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  approximateReadingMinutes,
  joinMetricsToRows,
  type PostMetrics,
  parseSortDirection,
  parseSortKey,
  pathFor,
  type StatsPostRow,
  sortPostMetrics,
} from "../lib/stats-posts";
import type { EngagementPost } from "../lib/stats-sections";

const IDENT = "writer.example";

function row(
  overrides: Partial<StatsPostRow> & { rkey: string },
): StatsPostRow {
  return {
    title: `post ${overrides.rkey}`,
    publishedAt: "2026-07-01T00:00:00.000Z",
    date: "July 1, 2026",
    readingMinutes: 3,
    editable: true,
    announced: null,
    ...overrides,
  };
}

describe("approximateReadingMinutes — one division, not a scan", () => {
  it("estimates from the body length and never rounds below a minute", () => {
    expect(approximateReadingMinutes("a".repeat(1232))).toBe(1);
    expect(approximateReadingMinutes("a")).toBe(1);
    // ~2,200 words of prose ≈ 10 minutes at 220 wpm.
    expect(approximateReadingMinutes("a".repeat(12_320))).toBe(10);
  });

  it("returns null when the document's text lives elsewhere", () => {
    // Documents carrying a foreign content union have no plaintext body here,
    // and "no estimate" is a different claim from "a one-minute read".
    expect(approximateReadingMinutes(undefined)).toBeNull();
    expect(approximateReadingMinutes("")).toBeNull();
  });
});

describe("parseSortKey / parseSortDirection — frozen allowlists", () => {
  it("accepts the known keys and falls back silently for anything else", () => {
    expect(parseSortKey("views")).toBe("views");
    expect(parseSortKey("reposts")).toBe("reposts");
    for (const junk of [undefined, "", "rkey", "views; DROP", 7, {}]) {
      expect(parseSortKey(junk)).toBe("date");
    }
  });

  it("accepts only 'asc' as an ascending request", () => {
    expect(parseSortDirection("asc")).toBe("asc");
    for (const junk of [undefined, "ASC", "descending", 1]) {
      expect(parseSortDirection(junk)).toBe("desc");
    }
  });
});

const engagement = (
  rkey: string,
  counts: Partial<EngagementPost> = {},
): EngagementPost => ({
  rkey,
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  postRkey: "aaa",
  likes: null,
  reposts: null,
  quotes: null,
  replies: null,
  ...counts,
});

describe("joinMetricsToRows — absent is not zero, and no row is hidden", () => {
  it("joins views by the post's public path and Bluesky counts by record key", () => {
    const metrics = joinMetricsToRows({
      rows: [row({ rkey: "aaa" })],
      paths: [{ path: pathFor(IDENT, "aaa"), views: 30 }],
      engagement: [engagement("aaa", { likes: 12, replies: 3 })],
      ident: IDENT,
    });
    expect(metrics[0]).toMatchObject({
      rkey: "aaa",
      views: 30,
      likes: 12,
      replies: 3,
      reposts: null,
    });
  });

  it("keeps a row the metrics say nothing about, with nulls not zeros", () => {
    // A table that hides rows it lacks numbers for is a table that lies about
    // how much the writer has written.
    const metrics = joinMetricsToRows({
      rows: [row({ rkey: "aaa" }), row({ rkey: "bbb" })],
      paths: [{ path: pathFor(IDENT, "aaa"), views: 30 }],
      engagement: [],
      ident: IDENT,
    });
    expect(metrics).toHaveLength(2);
    expect(metrics[1]).toMatchObject({ views: null, likes: null });
  });

  it("leaves every view cell null when the reader-count section failed", () => {
    const metrics = joinMetricsToRows({
      rows: [row({ rkey: "aaa" })],
      paths: null,
      engagement: null,
      ident: IDENT,
    });
    expect(metrics[0].views).toBeNull();
  });

  it("carries the vanished-announcement flag through to the row", () => {
    const metrics = joinMetricsToRows({
      rows: [row({ rkey: "aaa" })],
      paths: [],
      engagement: [engagement("aaa", { gone: true })],
      ident: IDENT,
    });
    expect(metrics[0].gone).toBe(true);
  });
});

function metrics(
  entries: Array<Partial<PostMetrics> & { rkey: string }>,
): PostMetrics[] {
  return entries.map((entry) => ({
    ...row({ rkey: entry.rkey }),
    views: null,
    likes: null,
    reposts: null,
    replies: null,
    gone: false,
    ...entry,
  }));
}

describe("sortPostMetrics — unknowns last in BOTH directions", () => {
  const rows = metrics([
    { rkey: "low", views: 5 },
    { rkey: "high", views: 900 },
    { rkey: "unknown", views: null },
  ]);

  it("sorts descending by default", () => {
    expect(sortPostMetrics(rows, "views", "desc").map((r) => r.rkey)).toEqual([
      "high",
      "low",
      "unknown",
    ]);
  });

  it("keeps unknowns last when sorting ascending", () => {
    // Sorting by views ascending asks which post did WORST. The answer is not
    // "the posts published before we started counting".
    expect(sortPostMetrics(rows, "views", "asc").map((r) => r.rkey)).toEqual([
      "low",
      "high",
      "unknown",
    ]);
  });

  it("sorts every metric column in both directions", () => {
    for (const key of ["views", "likes", "reposts", "replies", "read"] as const)
      for (const dir of ["asc", "desc"] as const) {
        const sorted = sortPostMetrics(
          metrics([
            {
              rkey: "a",
              views: 1,
              likes: 1,
              reposts: 1,
              replies: 1,
              readingMinutes: 1,
            },
            {
              rkey: "b",
              views: 2,
              likes: 2,
              reposts: 2,
              replies: 2,
              readingMinutes: 2,
            },
            { rkey: "c", readingMinutes: null },
          ]),
          key,
          dir,
        );
        expect(sorted).toHaveLength(3);
        expect(sorted[2].rkey).toBe("c");
      }
  });

  it("sorts titles alphabetically, case-insensitively", () => {
    const sorted = sortPostMetrics(
      metrics([
        { rkey: "z", title: "zebra" },
        { rkey: "a", title: "Apple" },
      ]),
      "title",
      "asc",
    );
    expect(sorted.map((r) => r.title)).toEqual(["Apple", "zebra"]);
  });

  it("sorts by date, treating a missing date as unknown", () => {
    const sorted = sortPostMetrics(
      metrics([
        { rkey: "old", publishedAt: "2025-01-01T00:00:00.000Z" },
        { rkey: "new", publishedAt: "2026-07-01T00:00:00.000Z" },
        { rkey: "undated", publishedAt: null },
      ]),
      "date",
      "desc",
    );
    expect(sorted.map((r) => r.rkey)).toEqual(["new", "old", "undated"]);
  });

  it("is stable and does not mutate its input", () => {
    const input = metrics([
      { rkey: "b", views: 5 },
      { rkey: "a", views: 5 },
    ]);
    const order = input.map((r) => r.rkey);
    // Equal values break by record key, so a re-sort is deterministic.
    expect(sortPostMetrics(input, "views", "desc").map((r) => r.rkey)).toEqual([
      "a",
      "b",
    ]);
    expect(input.map((r) => r.rkey)).toEqual(order);
  });
});
