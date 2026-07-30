// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ListedRecord, StandardDocument } from "../lib/atproto";
import { RELATED_POSTS_LIMIT, selectRelatedPosts } from "../lib/related-posts";

function record(
  rkey: string,
  value: Partial<StandardDocument>,
): ListedRecord<StandardDocument> {
  return {
    uri: `at://did:plc:fake0000000000writer0000/site.standard.document/${rkey}`,
    cid: `bafkrei${rkey}`,
    value,
  };
}

describe("selectRelatedPosts — same-writer only", () => {
  it("excludes the current document by rkey", () => {
    const records = [
      record("current", {
        title: "Current",
        publishedAt: "2026-01-03T00:00:00Z",
      }),
      record("other", { title: "Other", publishedAt: "2026-01-02T00:00:00Z" }),
    ];
    const related = selectRelatedPosts(records, "current");
    expect(related.map((p) => p.rkey)).toEqual(["other"]);
  });

  it("sorts newest first by publishedAt", () => {
    const records = [
      record("a", { title: "A", publishedAt: "2026-01-01T00:00:00Z" }),
      record("b", { title: "B", publishedAt: "2026-01-03T00:00:00Z" }),
      record("c", { title: "C", publishedAt: "2026-01-02T00:00:00Z" }),
    ];
    const related = selectRelatedPosts(records, "excluded-rkey");
    expect(related.map((p) => p.rkey)).toEqual(["b", "c", "a"]);
  });

  it("caps at the limit (3 by default)", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      record(`p${i}`, {
        title: `Post ${i}`,
        publishedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const related = selectRelatedPosts(records, "excluded-rkey");
    expect(related).toHaveLength(RELATED_POSTS_LIMIT);
    expect(related.map((p) => p.rkey)).toEqual(["p9", "p8", "p7"]);
  });

  it("respects a custom limit", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record(`p${i}`, { title: `Post ${i}` }),
    );
    expect(selectRelatedPosts(records, "excluded-rkey", 2)).toHaveLength(2);
  });

  it("drops untitled records (matches mapDashboardRows hygiene)", () => {
    const records = [
      record("untitled", {}),
      record("blank-title", { title: "   " }),
      record("real", { title: "Real post" }),
    ];
    const related = selectRelatedPosts(records, "excluded-rkey");
    expect(related.map((p) => p.rkey)).toEqual(["real"]);
  });

  it("drops records with no usable rkey", () => {
    const malformed: ListedRecord<StandardDocument> = {
      uri: "at://did:plc:fake0000000000writer0000/site.standard.document/",
      cid: "bafkrei",
      value: { title: "No rkey" },
    };
    expect(selectRelatedPosts([malformed], "excluded-rkey")).toEqual([]);
  });

  it("returns an empty list when there's nothing else to show", () => {
    const records = [record("current", { title: "Current" })];
    expect(selectRelatedPosts(records, "current")).toEqual([]);
  });
});
