// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  filterPostsByQuery,
  groupPostsByMonth,
  monogram,
  monthYearLabel,
} from "../lib/archive";

describe("monthYearLabel", () => {
  it("formats an ISO date as 'Month YYYY' in UTC", () => {
    expect(monthYearLabel("2026-01-15T23:00:00Z")).toBe("January 2026");
  });

  it("falls back to 'Undated' for null or unparseable dates", () => {
    expect(monthYearLabel(null)).toBe("Undated");
    expect(monthYearLabel("not a date")).toBe("Undated");
  });
});

describe("groupPostsByMonth", () => {
  it("groups consecutive same-month posts under one header", () => {
    const posts = [
      { id: 1, publishedAt: "2026-02-05T00:00:00Z" },
      { id: 2, publishedAt: "2026-02-01T00:00:00Z" },
      { id: 3, publishedAt: "2026-01-20T00:00:00Z" },
    ];
    const groups = groupPostsByMonth(posts);
    expect(groups).toEqual([
      { label: "February 2026", posts: [posts[0], posts[1]] },
      { label: "January 2026", posts: [posts[2]] },
    ]);
  });

  it("buckets undated posts together rather than dropping them", () => {
    const posts = [
      { id: 1, publishedAt: null },
      { id: 2, publishedAt: null },
    ];
    expect(groupPostsByMonth(posts)).toEqual([{ label: "Undated", posts }]);
  });

  it("returns an empty list for an empty input", () => {
    expect(groupPostsByMonth([])).toEqual([]);
  });
});

describe("filterPostsByQuery", () => {
  const posts = [
    {
      title: "Publishing on the open network",
      description: "A protocol primer.",
    },
    { title: "Newsletters are coming", description: null },
    {
      title: "Why writers own their words",
      description: "On leverage and exit.",
    },
  ];

  it("returns everything unfiltered for a blank query", () => {
    expect(filterPostsByQuery(posts, "")).toEqual(posts);
    expect(filterPostsByQuery(posts, "   ")).toEqual(posts);
  });

  it("matches case-insensitively against the title", () => {
    expect(filterPostsByQuery(posts, "NEWSLETTERS")).toEqual([posts[1]]);
  });

  it("matches against the dek/description when the title doesn't match", () => {
    expect(filterPostsByQuery(posts, "leverage")).toEqual([posts[2]]);
  });

  it("tolerates a null description without throwing", () => {
    expect(filterPostsByQuery(posts, "coming")).toEqual([posts[1]]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterPostsByQuery(posts, "xyzzy")).toEqual([]);
  });
});

describe("monogram", () => {
  it("uppercases the first grapheme of a name", () => {
    expect(monogram("substack refugees")).toBe("S");
  });

  it("falls back to '?' for a blank/whitespace name", () => {
    expect(monogram("")).toBe("?");
    expect(monogram("   ")).toBe("?");
  });

  it("never splits an emoji/combining sequence", () => {
    expect(monogram("👋 hello")).toBe("👋");
  });
});
