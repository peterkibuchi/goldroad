// @vitest-environment node
/**
 * The archive's `?q=` on the loader side: an indexed writer's search answers
 * from the index without listing their repo, anyone else's filters the newest
 * page and says so, and a search is never cached or indexed by crawlers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as atproto from "~/lib/atproto";
import * as search from "~/lib/search";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveDidToPds: vi.fn(async () => "https://pds.example"),
  listRecords: vi.fn(async () => []),
  listRecordsPage: vi.fn(),
}));
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  checkHidden: vi.fn(async () => false),
}));
vi.mock("~/lib/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/search")>()),
  searchPublication: vi.fn(),
}));

import { isCacheableReadRequest } from "../lib/read-cache";
import { Route } from "../routes/@{$handle}.index";

type Options = {
  validateSearch: (s: Record<string, unknown>) => { q?: string };
  loader: (ctx: {
    params: { handle: string };
    deps: { cursor?: string; q?: string };
  }) => Promise<Record<string, unknown>>;
  headers: (ctx: {
    loaderData?: unknown;
  }) => Record<string, string> | undefined;
  head: (ctx: { loaderData?: unknown }) => {
    meta?: Array<Record<string, string>>;
  };
};
const options = Route.options as unknown as Options;
const load = (deps: { cursor?: string; q?: string }) =>
  options.loader({ params: { handle: DID }, deps });

const doc = (rkey: string, title: string, description?: string) => ({
  uri: `at://${DID}/site.standard.document/${rkey}`,
  cid: "bafyrei",
  value: { $type: "site.standard.document", title, description },
});

beforeEach(() => {
  vi.mocked(atproto.listRecordsPage).mockReset();
  vi.mocked(search.searchPublication).mockReset();
  vi.mocked(atproto.listRecordsPage).mockResolvedValue({
    records: [
      doc("3ma", "Slow gardens"),
      doc("3mb", "Fast cars", "about slow roads"),
    ],
    cursor: "next",
  });
});

describe("archive search — loader", () => {
  it("answers an indexed writer from the index, without listing the repo", async () => {
    const hits = [
      {
        rkey: "3ma",
        title: "Slow",
        snippet: "…",
        description: "",
        publishedAt: null,
      },
    ];
    vi.mocked(search.searchPublication).mockResolvedValue({
      ready: true,
      hits,
      more: false,
    });
    const data = await load({ q: "slow" });
    expect(search.searchPublication).toHaveBeenCalledWith({
      data: { did: DID, q: "slow" },
    });
    expect(atproto.listRecordsPage).not.toHaveBeenCalled();
    expect(data.search).toEqual({
      q: "slow",
      scope: "full",
      hits,
      more: false,
    });
    expect(data.nextCursor).toBeNull();
  });

  it("filters the newest page's titles and summaries when there's no index", async () => {
    vi.mocked(search.searchPublication).mockResolvedValue({ ready: false });
    const data = await load({ q: "slow", cursor: "older" });
    // The note says "most recent", so the cursor is not honoured here.
    expect(vi.mocked(atproto.listRecordsPage).mock.calls[0]?.[3]).toMatchObject(
      {
        cursor: undefined,
      },
    );
    const found = data.search as { scope: string; hits: { rkey: string }[] };
    expect(found.scope).toBe("titles");
    expect(found.hits.map((h) => h.rkey).sort()).toEqual(["3ma", "3mb"]);
  });

  it("can't be made to show a fake highlight from another server's title", async () => {
    vi.mocked(search.searchPublication).mockResolvedValue({ ready: false });
    vi.mocked(atproto.listRecordsPage).mockResolvedValue({
      records: [doc("3ma", "slow \u0002fake\u0003 title")],
      cursor: null,
    });
    const data = await load({ q: "slow" });
    const [hit] = (data.search as { hits: { title: string }[] }).hits;
    expect(hit.title).toBe("slow fake title");
  });

  it("falls back to the title filter when the search call itself fails", async () => {
    vi.mocked(search.searchPublication).mockRejectedValue(new Error("network"));
    const data = await load({ q: "slow" });
    expect((data.search as { scope: string }).scope).toBe("titles");
  });

  it("never asks the index when nobody searched", async () => {
    const data = await load({});
    expect(search.searchPublication).not.toHaveBeenCalled();
    expect(data.search).toBeNull();
    expect(options.headers({ loaderData: data })).toBeUndefined();
  });

  it("keeps a search out of every cache and every search engine", async () => {
    vi.mocked(search.searchPublication).mockResolvedValue({ ready: false });
    const data = await load({ q: "slow" });
    expect(options.headers({ loaderData: data })).toEqual({
      "cache-control": "no-store",
    });
    expect(options.head({ loaderData: data }).meta).toContainEqual({
      name: "robots",
      content: "noindex",
    });
  });

  it("reads the query from the URL trimmed and capped, and drops an empty one", () => {
    expect(options.validateSearch({ q: "  slow   garden " }).q).toBe(
      "slow garden",
    );
    expect(options.validateSearch({ q: "x".repeat(500) }).q).toHaveLength(200);
    expect(options.validateSearch({ q: "   " }).q).toBeUndefined();
    expect(options.validateSearch({ q: ["a"] }).q).toBeUndefined();
  });
});

describe("archive search — the edge cache", () => {
  const get = (path: string) => new Request(`https://trygoldroad.com${path}`);

  it("never serves or stores a search", () => {
    expect(isCacheableReadRequest(get("/@writer.example?q=slow"))).toBe(false);
    expect(isCacheableReadRequest(get("/@writer.example/?q="))).toBe(false);
  });

  it("still caches the archive, its pages and its posts", () => {
    expect(isCacheableReadRequest(get("/@writer.example"))).toBe(true);
    expect(isCacheableReadRequest(get("/@writer.example?cursor=abc"))).toBe(
      true,
    );
    // A post page ignores the param, so it keeps its cache.
    expect(isCacheableReadRequest(get("/@writer.example/3ma?q=slow"))).toBe(
      true,
    );
  });
});
