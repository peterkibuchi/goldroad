// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ListedRecord, StandardDocument } from "../lib/atproto";
import { mapDashboardRows } from "../lib/dashboard";

const DID = "did:plc:fakefakefakefakefakefake";

function rec(
  rkey: string,
  value: StandardDocument,
): ListedRecord<StandardDocument> {
  return {
    uri: `at://${DID}/site.standard.document/${rkey}`,
    cid: "bafyreib-canary-not-a-real-cid",
    value,
  };
}

describe("mapDashboardRows", () => {
  it("sorts newest first by publishedAt, falling back to rkey", () => {
    const rows = mapDashboardRows([
      rec("3aaa2aaa2aaa2", { title: "old", publishedAt: "2026-01-01" }),
      rec("3ccc2ccc2ccc2", { title: "new", publishedAt: "2026-07-01" }),
      rec("3bbb2bbb2bbb2", { title: "mid", publishedAt: "2026-03-01" }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(["new", "mid", "old"]);
  });

  it("sorts undated records by rkey (TIDs are time-ordered), newest first", () => {
    const rows = mapDashboardRows([
      rec("3aaa2aaa2aaa2", { title: "older" }),
      rec("3bbb2bbb2bbb2", { title: "newer" }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(["newer", "older"]);
  });

  it("marks rich-content-union documents as not editable", () => {
    const rows = mapDashboardRows([
      rec("3aaa2aaa2aaa2", {
        title: "leaflet post",
        content: { $type: "pub.leaflet.content" },
      }),
      rec("3bbb2bbb2bbb2", { title: "goldroad post", textContent: "body" }),
    ]);
    expect(rows.find((r) => r.title === "leaflet post")?.editable).toBe(false);
    expect(rows.find((r) => r.title === "goldroad post")?.editable).toBe(true);
  });

  it("keeps untitled records visible (still deletable) under a placeholder", () => {
    const rows = mapDashboardRows([rec("3aaa2aaa2aaa2", { title: "  " })]);
    expect(rows[0]?.title).toBe("(untitled)");
  });

  it("carries the description as an excerpt, blank-normalized to null", () => {
    const rows = mapDashboardRows([
      rec("3aaa2aaa2aaa2", { title: "with", description: "An excerpt." }),
      rec("3bbb2bbb2bbb2", { title: "blank", description: "   " }),
      rec("3ccc2ccc2ccc2", { title: "none" }),
    ]);
    expect(rows.find((r) => r.title === "with")?.description).toBe(
      "An excerpt.",
    );
    expect(rows.find((r) => r.title === "blank")?.description).toBeNull();
    expect(rows.find((r) => r.title === "none")?.description).toBeNull();
  });

  it("drops records whose uri has no usable rkey", () => {
    const rows = mapDashboardRows([
      // trailing slash → empty rkey; space → invalid rkey charset
      { uri: `at://${DID}/site.standard.document/`, cid: "x", value: {} },
      {
        uri: `at://${DID}/site.standard.document/bad key`,
        cid: "x",
        value: {},
      },
      rec("3aaa2aaa2aaa2", { title: "kept" }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(["kept"]);
  });

  it("ignores non-string metadata fields instead of trusting the network shape", () => {
    const rows = mapDashboardRows([
      rec("3aaa2aaa2aaa2", {
        title: "t",
        publishedAt: 42 as unknown as string,
        updatedAt: null as unknown as string,
      }),
    ]);
    expect(rows[0]).toMatchObject({ publishedAt: null, updatedAt: null });
  });

  it("derives the announced state from a bskyPostRef strongRef", () => {
    const rows = mapDashboardRows([
      rec("3aaa2aaa2aaa2", {
        title: "announced",
        bskyPostRef: {
          uri: `at://${DID}/app.bsky.feed.post/3lz2post2key2`,
          cid: "bafyreib-canary-not-a-real-cid",
        },
      }),
      rec("3bbb2bbb2bbb2", { title: "not announced" }),
    ]);
    expect(rows.find((r) => r.title === "announced")?.announced).toEqual({
      did: DID,
      postRkey: "3lz2post2key2",
    });
    expect(rows.find((r) => r.title === "not announced")?.announced).toBeNull();
  });

  it("rejects bskyPostRefs that don't point at an app.bsky.feed.post", () => {
    const rows = mapDashboardRows([
      // A ref to some other collection must not masquerade as announce status.
      rec("3aaa2aaa2aaa2", {
        title: "wrong collection",
        bskyPostRef: {
          uri: `at://${DID}/site.standard.document/3lz2post2key2`,
          cid: "bafyreib-canary-not-a-real-cid",
        },
      }),
      rec("3bbb2bbb2bbb2", {
        title: "malformed",
        bskyPostRef: { uri: "not-an-at-uri", cid: "x" },
      }),
      rec("3ccc2ccc2ccc2", {
        title: "non-string",
        bskyPostRef: { uri: 42, cid: "x" },
      }),
    ]);
    for (const row of rows) expect(row.announced).toBeNull();
  });
});
