// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ListedRecord, StandardDocument } from "../lib/atproto";
import {
  DATE_COLUMN,
  type DashboardRow,
  joinStatsToRows,
  mapDashboardRows,
  POST_SORTS,
  parsePostSort,
  sortingStateFor,
  VIEWS_COLUMN,
  viewsByRkey,
} from "../lib/dashboard";

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

describe("joinStatsToRows", () => {
  const IDENT = "writer.example";

  function row(rkey: string, title = "a post"): DashboardRow {
    return {
      rkey,
      title,
      description: null,
      publishedAt: null,
      updatedAt: null,
      coverPath: null,
      readingMinutes: 0,
      editable: true,
      announced: null,
    };
  }

  it("attaches views to rows whose path matches /@{ident}/{rkey}", () => {
    const rows = [
      row("3aaa2aaa2aaa2", "post a"),
      row("3bbb2bbb2bbb2", "post b"),
    ];
    const joined = joinStatsToRows(
      rows,
      [
        { path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 12 },
        { path: `/@${IDENT}/3bbb2bbb2bbb2`, views: 3 },
      ],
      IDENT,
    );
    expect(joined).toEqual([
      { rkey: "3aaa2aaa2aaa2", title: "post a", views: 12 },
      { rkey: "3bbb2bbb2bbb2", title: "post b", views: 3 },
    ]);
  });

  it("omits rows with no matching path instead of showing 0 views", () => {
    const rows = [
      row("3aaa2aaa2aaa2", "has views"),
      row("3bbb2bbb2bbb2", "no views yet"),
    ];
    const joined = joinStatsToRows(
      rows,
      [{ path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 5 }],
      IDENT,
    );
    expect(joined).toEqual([
      { rkey: "3aaa2aaa2aaa2", title: "has views", views: 5 },
    ]);
    expect(joined.some((p) => p.rkey === "3bbb2bbb2bbb2")).toBe(false);
  });

  it("ignores the publication-root path (no rkey suffix) and other writers' paths", () => {
    const rows = [row("3aaa2aaa2aaa2", "post a")];
    const joined = joinStatsToRows(
      rows,
      [
        { path: `/@${IDENT}`, views: 40 },
        { path: `/@someone-else/3aaa2aaa2aaa2`, views: 9 },
      ],
      IDENT,
    );
    expect(joined).toEqual([]);
  });
});

describe("mapDashboardRows — row metrics", () => {
  it("serves a cover blob through the /img proxy when the writer's DID is known", () => {
    const [row] = mapDashboardRows(
      [
        rec("3aaa2aaa2aaa2", {
          title: "with a cover",
          coverImage: {
            $type: "blob",
            ref: {
              $link:
                "bafkreialhpg6bpwsn3ffbwmnrsg2ur4pbnzlwd3xatgcyvjdxbmhefjxya",
            },
            mimeType: "image/jpeg",
            size: 1234,
          },
        } as never),
      ],
      DID,
    );
    // The /img proxy path encodes the DID — colons are escaped.
    expect(row.coverPath).toBe(
      `/img/${encodeURIComponent(DID)}/bafkreialhpg6bpwsn3ffbwmnrsg2ur4pbnzlwd3xatgcyvjdxbmhefjxya`,
    );
  });

  it("leaves rows cover-less when there is no cover or no DID to serve it from", () => {
    const [noCover] = mapDashboardRows(
      [rec("3aaa2aaa2aaa2", { title: "plain" })],
      DID,
    );
    expect(noCover.coverPath).toBeNull();
    const [noDid] = mapDashboardRows([
      rec("3aaa2aaa2aaa2", { title: "plain" }),
    ]);
    expect(noDid.coverPath).toBeNull();
  });

  it("estimates reading time from the record's own body, and 0 when there is none", () => {
    const [withBody] = mapDashboardRows([
      rec("3aaa2aaa2aaa2", {
        title: "an essay",
        textContent: "word ".repeat(500),
      }),
    ]);
    expect(withBody.readingMinutes).toBeGreaterThan(0);
    const [empty] = mapDashboardRows([rec("3bbb2bbb2bbb2", { title: "stub" })]);
    expect(empty.readingMinutes).toBe(0);
  });
});

describe("viewsByRkey", () => {
  const IDENT = "writer.example";
  function plain(rkey: string): DashboardRow {
    return {
      rkey,
      title: "a post",
      description: null,
      publishedAt: null,
      updatedAt: null,
      coverPath: null,
      readingMinutes: 0,
      editable: true,
      announced: null,
    };
  }

  it("keys the join by rkey for a row-at-a-time lookup", () => {
    const map = viewsByRkey(
      [plain("3aaa2aaa2aaa2")],
      [{ path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 12 }],
      IDENT,
    );
    expect(map.get("3aaa2aaa2aaa2")).toBe(12);
  });

  it("leaves an unrecorded post OUT of the map — absence, never zero", () => {
    const map = viewsByRkey([plain("3aaa2aaa2aaa2")], [], IDENT);
    expect(map.has("3aaa2aaa2aaa2")).toBe(false);
    expect(map.get("3aaa2aaa2aaa2")).toBeUndefined();
  });
});

describe("sortingStateFor", () => {
  it("maps newest and oldest onto one date column, in both directions", () => {
    expect(sortingStateFor("newest")).toEqual([
      { id: DATE_COLUMN, desc: true },
    ]);
    expect(sortingStateFor("oldest")).toEqual([
      { id: DATE_COLUMN, desc: false },
    ]);
  });

  it("maps most-read onto the views column, descending", () => {
    expect(sortingStateFor("most-read")).toEqual([
      { id: VIEWS_COLUMN, desc: true },
    ]);
  });
});

describe("parsePostSort", () => {
  it("accepts every sort the control actually offers", () => {
    for (const sort of POST_SORTS) expect(parsePostSort(sort)).toBe(sort);
  });

  it("falls back to newest for anything else", () => {
    // A <select>'s value is a string; it used to be asserted straight into a
    // PostSort, so a value the table has no column for would have reached
    // sortingStateFor and sorted by an id that doesn't exist.
    expect(parsePostSort("")).toBe("newest");
    expect(parsePostSort("most_read")).toBe("newest");
    expect(parsePostSort("date")).toBe("newest");
    expect(parsePostSort("__proto__")).toBe("newest");
  });

  it("hands sortingStateFor a column the table has, whatever it is given", () => {
    const columns = [DATE_COLUMN, VIEWS_COLUMN];
    for (const value of ["newest", "oldest", "most-read", "nonsense"]) {
      for (const state of sortingStateFor(parsePostSort(value)))
        expect(columns).toContain(state.id);
    }
  });
});
