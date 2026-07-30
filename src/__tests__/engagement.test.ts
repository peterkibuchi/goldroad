// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  announcedPostUri,
  bskyPostUrl,
  bskyProfileUrl,
  ENGAGEMENT_CACHE_TTL_SECONDS,
  fetchPostsEngagement,
  getDocumentEngagement,
  getPostsEngagement,
  hasCountedEngagement,
  MAX_GET_POSTS_BATCH,
} from "../lib/engagement";

describe("bskyPostUrl / bskyProfileUrl — raw actor, no percent-encoding", () => {
  it("builds a bsky.app post URL from a raw handle or DID", () => {
    expect(bskyPostUrl("writer.example", "3lyk73wxnok2f")).toBe(
      "https://bsky.app/profile/writer.example/post/3lyk73wxnok2f",
    );
    expect(
      bskyPostUrl("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "3lyk73wxnok2f"),
    ).toBe(
      "https://bsky.app/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/post/3lyk73wxnok2f",
    );
  });

  it("builds a bsky.app profile URL the same way", () => {
    expect(bskyProfileUrl("writer.example")).toBe(
      "https://bsky.app/profile/writer.example",
    );
  });
});

describe("announcedPostUri — bskyPostRef validation", () => {
  it("accepts a well-formed app.bsky.feed.post at:// ref", () => {
    const ref = {
      uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3lyk73wxnok2f",
    };
    expect(announcedPostUri(ref)).toEqual({
      uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3lyk73wxnok2f",
      did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      rkey: "3lyk73wxnok2f",
    });
  });

  it("rejects a missing ref (never announced)", () => {
    expect(announcedPostUri(undefined)).toBeNull();
  });

  it("rejects a ref pointing at a different collection", () => {
    expect(
      announcedPostUri({
        uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/site.standard.document/abc",
      }),
    ).toBeNull();
  });

  it("rejects a malformed/hostile uri without throwing", () => {
    expect(announcedPostUri({ uri: "not-an-at-uri" })).toBeNull();
    expect(announcedPostUri({ uri: 42 })).toBeNull();
    expect(announcedPostUri({})).toBeNull();
  });
});

describe("fetchPostsEngagement — batched getPosts", () => {
  // The `url` param is declared (even where a case ignores it) so
  // `mock.calls` stays a typed 1-tuple the URL assertions can index.
  const okUpstream = (posts: unknown[]) =>
    vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ posts }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

  it("calls the public unauthenticated AppView host with the given URIs", async () => {
    const fetcher = okUpstream([
      {
        uri: "at://did:plc:aaaa/app.bsky.feed.post/1",
        likeCount: 5,
        replyCount: 2,
        repostCount: 1,
        quoteCount: 0,
      },
    ]);
    const result = await fetchPostsEngagement(
      ["at://did:plc:aaaa/app.bsky.feed.post/1"],
      fetcher as unknown as typeof fetch,
    );
    expect(result.get("at://did:plc:aaaa/app.bsky.feed.post/1")).toEqual({
      likeCount: 5,
      replyCount: 2,
      repostCount: 1,
      quoteCount: 0,
    });
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?",
    );
    expect(url).toContain("uris=at%3A%2F%2Fdid%3Aplc%3Aaaaa");
  });

  it("chunks a batch over 25 URIs into multiple calls of at most 25", async () => {
    const uris = Array.from(
      { length: 30 },
      (_, i) => `at://did:plc:aaaa/app.bsky.feed.post/${i}`,
    );
    const fetcher = okUpstream([]);
    await fetchPostsEngagement(uris, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const urisIn = (call: number) =>
      new URL(String(fetcher.mock.calls[call][0])).searchParams.getAll("uris")
        .length;
    const firstBatchSize = urisIn(0);
    const secondBatchSize = urisIn(1);
    expect(firstBatchSize).toBe(MAX_GET_POSTS_BATCH);
    expect(secondBatchSize).toBe(5);
  });

  it("treats every count as OPTIONAL, not zero, when the AppView omits it", async () => {
    const fetcher = okUpstream([
      { uri: "at://did:plc:aaaa/app.bsky.feed.post/1" },
    ]);
    const result = await fetchPostsEngagement(
      ["at://did:plc:aaaa/app.bsky.feed.post/1"],
      fetcher as unknown as typeof fetch,
    );
    const counts = result.get("at://did:plc:aaaa/app.bsky.feed.post/1");
    expect(counts?.likeCount).toBeUndefined();
    expect(counts?.replyCount).toBeUndefined();
    expect(counts).toBeDefined(); // the post itself was still found
  });

  it("drops hostile/malformed post entries instead of throwing", async () => {
    const fetcher = okUpstream([
      "junk",
      null,
      { uri: 42 },
      {
        uri: "at://did:plc:aaaa/app.bsky.feed.post/1",
        likeCount: "not a number",
      },
      { uri: "at://did:plc:aaaa/app.bsky.feed.post/2", likeCount: -5 },
      { uri: "at://did:plc:aaaa/app.bsky.feed.post/3", likeCount: 3 },
    ]);
    const result = await fetchPostsEngagement(
      [
        "at://did:plc:aaaa/app.bsky.feed.post/1",
        "at://did:plc:aaaa/app.bsky.feed.post/2",
        "at://did:plc:aaaa/app.bsky.feed.post/3",
      ],
      fetcher as unknown as typeof fetch,
    );
    expect(
      result.get("at://did:plc:aaaa/app.bsky.feed.post/1")?.likeCount,
    ).toBeUndefined();
    expect(
      result.get("at://did:plc:aaaa/app.bsky.feed.post/2")?.likeCount,
    ).toBeUndefined();
    expect(
      result.get("at://did:plc:aaaa/app.bsky.feed.post/3")?.likeCount,
    ).toBe(3);
  });

  it("treats a non-array `posts` body as empty rather than throwing", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ posts: "not an array" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await fetchPostsEngagement(
      ["at://did:plc:aaaa/app.bsky.feed.post/1"],
      fetcher as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
  });

  it("degrades to an empty result on network failure/timeout", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await fetchPostsEngagement(
      ["at://did:plc:aaaa/app.bsky.feed.post/1"],
      fetcher as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
  });

  it("degrades to an empty result on a non-2xx response", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await fetchPostsEngagement(
      ["at://did:plc:aaaa/app.bsky.feed.post/1"],
      fetcher as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
  });

  it("caps an oversized response body instead of buffering it", async () => {
    const huge = JSON.stringify({
      posts: [{ uri: "at://did:plc:aaaa/app.bsky.feed.post/1", likeCount: 1 }],
    }).padEnd(300_000, " ");
    const fetcher = vi.fn(
      async () =>
        new Response(huge, {
          status: 200,
          headers: { "content-length": String(huge.length) },
        }),
    );
    const result = await fetchPostsEngagement(
      ["at://did:plc:aaaa/app.bsky.feed.post/1"],
      fetcher as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
  });

  it("ignores non-at:// URIs before ever building a request", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ posts: [] }), { status: 200 }),
    );
    const result = await fetchPostsEngagement(
      ["https://evil.example/not-an-at-uri"],
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

describe("getDocumentEngagement — the document-page entry point", () => {
  const announcedRef = {
    uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3lyk73wxnok2f",
  };

  it("returns null for an unannounced post — no upstream call at all", async () => {
    const fetcher = vi.fn();
    const result = await getDocumentEngagement(undefined, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns counts + a bsky.app thread URL for an announced post", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            posts: [
              {
                uri: announcedRef.uri,
                likeCount: 12,
                replyCount: 3,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await getDocumentEngagement(announcedRef, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toEqual({
      counts: {
        likeCount: 12,
        replyCount: 3,
        repostCount: undefined,
        quoteCount: undefined,
      },
      threadUrl:
        "https://bsky.app/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/post/3lyk73wxnok2f",
    });
  });

  it("degrades to null (never throws) when the AppView call fails", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await getDocumentEngagement(announcedRef, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("caches a hit and never re-fetches on the second call", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            posts: [{ uri: announcedRef.uri, likeCount: 7 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const store = new Map<string, Response>();
    const fakeCache = {
      match: vi.fn(async (key: string) => store.get(key)?.clone()),
      put: vi.fn(async (key: string, res: Response) => {
        store.set(key, res.clone());
      }),
    } as unknown as Cache;

    const first = await getDocumentEngagement(announcedRef, {
      fetcher: fetcher as unknown as typeof fetch,
      cache: fakeCache,
    });
    const second = await getDocumentEngagement(announcedRef, {
      fetcher: fetcher as unknown as typeof fetch,
      cache: fakeCache,
    });

    expect(first?.counts.likeCount).toBe(7);
    expect(second?.counts.likeCount).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("exposes the cache TTL constant used to build the stored Cache-Control", () => {
    expect(ENGAGEMENT_CACHE_TTL_SECONDS).toBe(300);
  });
});

describe("hasCountedEngagement", () => {
  it("is false when the AppView counted nothing at all", () => {
    expect(hasCountedEngagement({})).toBe(false);
  });

  it("is true for a genuine zero — a counted zero is data, absence isn't", () => {
    expect(hasCountedEngagement({ likeCount: 0 })).toBe(true);
  });
});

describe("getPostsEngagement — the list entry point", () => {
  const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const uriFor = (rkey: string) => `at://${DID}/app.bsky.feed.post/${rkey}`;

  function jsonResponse(posts: unknown[]) {
    return new Response(JSON.stringify({ posts }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("keys results by the caller's own row id and carries a thread URL", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse([{ uri: uriFor("aaa"), likeCount: 3, replyCount: 1 }]),
    );
    const result = await getPostsEngagement(
      [{ key: "row-aaa", ref: { uri: uriFor("aaa") } }],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(result.get("row-aaa")?.counts.likeCount).toBe(3);
    expect(result.get("row-aaa")?.threadUrl).toBe(
      `https://bsky.app/profile/${DID}/post/aaa`,
    );
  });

  it("omits rows that were never announced, and makes no call for them", async () => {
    const fetcher = vi.fn(async () => jsonResponse([]));
    const result = await getPostsEngagement(
      [
        { key: "never-announced", ref: undefined },
        {
          key: "bad-collection",
          ref: { uri: `at://${DID}/app.bsky.feed.like/x` },
        },
      ],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(result.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("omits a row whose post the AppView didn't return, rather than zeroing it", async () => {
    const fetcher = vi.fn(async () => jsonResponse([]));
    const result = await getPostsEngagement(
      [{ key: "row-aaa", ref: { uri: uriFor("aaa") } }],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(result.has("row-aaa")).toBe(false);
  });

  it("asks for one URI once, even when two rows point at the same announcement", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse([{ uri: uriFor("aaa"), likeCount: 5 }]);
    });
    const result = await getPostsEngagement(
      [
        { key: "row-1", ref: { uri: uriFor("aaa") } },
        { key: "row-2", ref: { uri: uriFor("aaa") } },
      ],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const params = urls[0].split("?")[1];
    expect(new URLSearchParams(params).getAll("uris")).toHaveLength(1);
    // Both rows still get the answer.
    expect(result.get("row-1")?.counts.likeCount).toBe(5);
    expect(result.get("row-2")?.counts.likeCount).toBe(5);
  });

  it("ignores a URI the upstream echoed but nobody asked for", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse([
        { uri: uriFor("aaa"), likeCount: 1 },
        { uri: uriFor("unrequested"), likeCount: 999 },
      ]),
    );
    const result = await getPostsEngagement(
      [{ key: "row-aaa", ref: { uri: uriFor("aaa") } }],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(result.size).toBe(1);
    expect(result.get("row-aaa")?.counts.likeCount).toBe(1);
  });

  it("serves the second page of rows from the shared per-post cache", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse([{ uri: uriFor("aaa"), likeCount: 8 }]),
    );
    const store = new Map<string, Response>();
    const fakeCache = {
      match: vi.fn(async (key: string) => store.get(key)?.clone()),
      put: vi.fn(async (key: string, res: Response) => {
        store.set(key, res.clone());
      }),
    } as unknown as Cache;
    const refs = [{ key: "row-aaa", ref: { uri: uriFor("aaa") } }];

    const first = await getPostsEngagement(refs, {
      fetcher: fetcher as unknown as typeof fetch,
      cache: fakeCache,
    });
    const second = await getPostsEngagement(refs, {
      fetcher: fetcher as unknown as typeof fetch,
      cache: fakeCache,
    });
    expect(first.get("row-aaa")?.counts.likeCount).toBe(8);
    expect(second.get("row-aaa")?.counts.likeCount).toBe(8);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a whole page of rows to a single batched call", async () => {
    const rows = Array.from({ length: MAX_GET_POSTS_BATCH }, (_, i) => ({
      key: `row-${i}`,
      ref: { uri: uriFor(`k${i}`) },
    }));
    const fetcher = vi.fn(async () => jsonResponse([]));
    await getPostsEngagement(rows, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
