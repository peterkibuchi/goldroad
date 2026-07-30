// @vitest-environment node
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  COMMENTS_CACHE_TTL_SECONDS,
  getPostConversation,
  MAX_RENDERED_REPLIES,
  normalizeThread,
} from "../lib/comments";

const AUTHOR = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT_RKEY = "3lyk73wxnok2f";
const ROOT_URI = `at://${AUTHOR}/app.bsky.feed.post/${ROOT_RKEY}`;
const THREAD_URL = `https://bsky.app/profile/${AUTHOR}/post/${ROOT_RKEY}`;
const REF = { uri: ROOT_URI };
const EXPECTED = { uri: ROOT_URI, threadUrl: THREAD_URL };

let rkeySeed = 0;

/** A live #threadViewPost reply node, with only the fields we consume. */
function reply(
  opts: {
    did?: string;
    handle?: string;
    displayName?: string;
    text?: string;
    indexedAt?: string;
    createdAt?: string;
    rkey?: string;
    replyCount?: number;
  } = {},
) {
  const did = opts.did ?? "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const rkey = opts.rkey ?? `3reply${(rkeySeed++).toString().padStart(6, "0")}`;
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      uri: `at://${did}/app.bsky.feed.post/${rkey}`,
      cid: "bafyreiexamplecid",
      author: {
        did,
        handle: opts.handle ?? "reader.example",
        ...(opts.displayName === undefined
          ? {}
          : { displayName: opts.displayName }),
      },
      record: {
        $type: "app.bsky.feed.post",
        text: opts.text ?? "A thoughtful reply.",
        createdAt: opts.createdAt ?? "2026-02-01T10:00:00.000Z",
      },
      indexedAt: opts.indexedAt ?? "2026-02-01T10:00:01.000Z",
      ...(opts.replyCount === undefined ? {} : { replyCount: opts.replyCount }),
    },
  };
}

/** A whole getPostThread response with the given reply nodes. */
function threadResponse(replies: unknown[], rootUri = ROOT_URI) {
  return {
    thread: {
      $type: "app.bsky.feed.defs#threadViewPost",
      post: {
        uri: rootUri,
        cid: "bafyreirootcid",
        author: { did: AUTHOR, handle: "writer.example" },
        record: { text: "New post ↗", createdAt: "2026-01-05T00:00:00.000Z" },
        indexedAt: "2026-01-05T00:00:00.000Z",
        replyCount: replies.length,
      },
      replies,
    },
  };
}

type FetchStub = Mock<(url: string, init?: RequestInit) => Promise<Response>>;

/**
 * A vi mock typed as the real `fetch` at the boundary. Workers' fetch signature
 * also accepts Request/URL inputs, which these string-URL stubs never see — one
 * cast here keeps every call site below free of them, and `.mock.calls` stays
 * usefully typed for the URL and init assertions.
 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): FetchStub & typeof fetch {
  return vi.fn(handler) as unknown as FetchStub & typeof fetch;
}

/** A stub that answers every call with the given JSON body. */
const okUpstream = (body: unknown) =>
  stubFetch(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

describe("normalizeThread — reading a real reply out of the thread", () => {
  it("keeps the author, handle, text and a link to the reply itself", () => {
    const result = normalizeThread(
      threadResponse([
        reply({
          displayName: "A Reader",
          handle: "reader.example",
          rkey: "3lyreply00001",
          text: "This clarified something I'd been stuck on.",
        }),
      ]),
      EXPECTED,
    );
    expect(result).toEqual({
      replies: [
        {
          uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3lyreply00001",
          authorHandle: "reader.example",
          authorName: "A Reader",
          text: "This clarified something I'd been stuck on.",
          timestamp: "2026-02-01T10:00:01.000Z",
          url: "https://bsky.app/profile/reader.example/post/3lyreply00001",
          byAuthor: false,
        },
      ],
      threadUrl: THREAD_URL,
      hasMore: false,
    });
  });

  it("falls back to the handle when the author has no display name", () => {
    const result = normalizeThread(threadResponse([reply()]), EXPECTED);
    expect(result?.replies[0].authorName).toBeNull();
    expect(result?.replies[0].authorHandle).toBe("reader.example");
  });

  it("marks a reply from the post's own author", () => {
    const result = normalizeThread(
      threadResponse([
        reply({ did: AUTHOR, handle: "writer.example" }),
        reply({ handle: "reader.example" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies.map((r) => r.byAuthor)).toEqual([true, false]);
  });

  it("orders replies oldest-first regardless of the order upstream sent", () => {
    const result = normalizeThread(
      threadResponse([
        reply({ indexedAt: "2026-03-01T00:00:00.000Z", text: "third" }),
        reply({ indexedAt: "2026-01-01T00:00:00.000Z", text: "first" }),
        reply({ indexedAt: "2026-02-01T00:00:00.000Z", text: "second" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies.map((r) => r.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("prefers the network's indexedAt over the author's claimed createdAt", () => {
    // A client-set createdAt is routinely wrong — here, implausibly far future.
    const result = normalizeThread(
      threadResponse([
        reply({
          createdAt: "2099-01-01T00:00:00.000Z",
          indexedAt: "2026-02-01T10:00:01.000Z",
        }),
      ]),
      EXPECTED,
    );
    expect(result?.replies[0].timestamp).toBe("2026-02-01T10:00:01.000Z");
  });

  it("falls back to createdAt when indexedAt is missing or unparseable", () => {
    const node = reply({ createdAt: "2026-02-02T09:00:00.000Z" });
    node.post.indexedAt = "not a date";
    const result = normalizeThread(threadResponse([node]), EXPECTED);
    expect(result?.replies[0].timestamp).toBe("2026-02-02T09:00:00.000Z");
  });
});

describe("normalizeThread — absence is not zero", () => {
  it("returns null for an announcement nobody has replied to", () => {
    expect(normalizeThread(threadResponse([]), EXPECTED)).toBeNull();
  });

  it("returns null when the thread carries no replies field at all", () => {
    const body = threadResponse([]) as {
      thread: { replies?: unknown };
    };
    delete body.thread.replies;
    expect(normalizeThread(body, EXPECTED)).toBeNull();
  });

  it("returns null when every reply was unrenderable", () => {
    expect(
      normalizeThread(
        threadResponse([
          {
            $type: "app.bsky.feed.defs#notFoundPost",
            uri: "at://x",
            notFound: true,
          },
        ]),
        EXPECTED,
      ),
    ).toBeNull();
  });
});

describe("normalizeThread — the union members that aren't posts", () => {
  it("drops a deleted reply rather than rendering a broken row", () => {
    const result = normalizeThread(
      threadResponse([
        {
          $type: "app.bsky.feed.defs#notFoundPost",
          uri: "at://did:plc:cccccccccccccccccccccccc/app.bsky.feed.post/3gone",
          notFound: true,
        },
        reply({ text: "still here" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies).toHaveLength(1);
    expect(result?.replies[0].text).toBe("still here");
  });

  it("drops a blocked reply", () => {
    const result = normalizeThread(
      threadResponse([
        {
          $type: "app.bsky.feed.defs#blockedPost",
          uri: "at://did:plc:cccccccccccccccccccccccc/app.bsky.feed.post/3blk",
          blocked: true,
          author: { did: "did:plc:cccccccccccccccccccccccc" },
        },
        reply({ text: "still here" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies).toHaveLength(1);
  });

  it("drops a union member it has never seen before", () => {
    const result = normalizeThread(
      threadResponse([
        { $type: "app.bsky.feed.defs#somethingNewIn2027", uri: "at://x" },
        reply({ text: "still here" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies).toHaveLength(1);
  });

  it("discriminates on shape too, so a member without $type still drops", () => {
    const result = normalizeThread(
      threadResponse([
        { uri: "at://x", notFound: true },
        { uri: "at://y", blocked: true, author: { did: AUTHOR } },
        reply({ text: "still here" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies).toHaveLength(1);
  });

  it("returns null when the root post itself is gone", () => {
    expect(
      normalizeThread(
        {
          thread: {
            $type: "app.bsky.feed.defs#notFoundPost",
            uri: ROOT_URI,
            notFound: true,
          },
        },
        EXPECTED,
      ),
    ).toBeNull();
  });

  it("returns null when the root post is blocked", () => {
    expect(
      normalizeThread(
        {
          thread: {
            $type: "app.bsky.feed.defs#blockedPost",
            uri: ROOT_URI,
            blocked: true,
            author: { did: AUTHOR },
          },
        },
        EXPECTED,
      ),
    ).toBeNull();
  });
});

describe("normalizeThread — refusing to render what it can't attribute", () => {
  it("returns null when the root isn't the post we asked about", () => {
    // Guards the same class of bug ~/lib/engagement's URI-keyed join does:
    // one post's replies must never appear under a different post.
    const other = `at://${AUTHOR}/app.bsky.feed.post/3differentpost`;
    expect(
      normalizeThread(threadResponse([reply()], other), EXPECTED),
    ).toBeNull();
  });

  it("drops a reply whose author DID disagrees with its own URI", () => {
    const node = reply({ did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" });
    node.post.author.did = "did:plc:dddddddddddddddddddddddd";
    expect(normalizeThread(threadResponse([node]), EXPECTED)).toBeNull();
  });

  it("drops a reply with no author handle", () => {
    const node = reply();
    node.post.author = { did: node.post.author.did } as typeof node.post.author;
    expect(normalizeThread(threadResponse([node]), EXPECTED)).toBeNull();
  });

  it("drops an image-only reply — there is no text to read", () => {
    expect(
      normalizeThread(threadResponse([reply({ text: "   " })]), EXPECTED),
    ).toBeNull();
  });

  it("drops a reply whose record is missing or malformed", () => {
    const node = reply();
    node.post.record = { text: 42 } as unknown as typeof node.post.record;
    expect(normalizeThread(threadResponse([node]), EXPECTED)).toBeNull();
  });

  it("de-duplicates replies that arrive twice under the same URI", () => {
    const result = normalizeThread(
      threadResponse([
        reply({ rkey: "3lysame0001" }),
        reply({ rkey: "3lysame0001" }),
      ]),
      EXPECTED,
    );
    expect(result?.replies).toHaveLength(1);
  });

  it("clamps an over-long display name away rather than rendering it", () => {
    const result = normalizeThread(
      threadResponse([reply({ displayName: "x".repeat(700) })]),
      EXPECTED,
    );
    expect(result?.replies[0].authorName).toBeNull();
  });

  it("clamps reply text to the lexicon's own limit", () => {
    const result = normalizeThread(
      threadResponse([reply({ text: "y".repeat(9000) })]),
      EXPECTED,
    );
    expect(result?.replies[0].text).toHaveLength(3000);
  });
});

describe("normalizeThread — shallow by design", () => {
  it("renders at most MAX_RENDERED_REPLIES and says there is more", () => {
    const many = Array.from({ length: MAX_RENDERED_REPLIES + 5 }, (_, i) =>
      reply({
        indexedAt: `2026-02-01T10:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    const result = normalizeThread(threadResponse(many), EXPECTED);
    expect(result?.replies).toHaveLength(MAX_RENDERED_REPLIES);
    expect(result?.hasMore).toBe(true);
  });

  it("flags more-to-read when a reply has replies of its own", () => {
    const result = normalizeThread(
      threadResponse([reply({ replyCount: 3 })]),
      EXPECTED,
    );
    expect(result?.replies).toHaveLength(1);
    expect(result?.hasMore).toBe(true);
  });

  it("does not claim more-to-read just because a reply was deleted", () => {
    // Dropped rows aren't "more conversation over there" — saying so would be
    // a promise the thread doesn't keep.
    const result = normalizeThread(
      threadResponse([
        {
          $type: "app.bsky.feed.defs#notFoundPost",
          uri: "at://x",
          notFound: true,
        },
        reply(),
      ]),
      EXPECTED,
    );
    expect(result?.hasMore).toBe(false);
  });
});

describe("normalizeThread — malformed and hostile bodies", () => {
  it("returns null instead of throwing on any of them", () => {
    for (const body of [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { thread: null },
      { thread: "nope" },
      { thread: {} },
      { thread: { post: null } },
      { thread: { post: { uri: 42 } } },
      { thread: { post: { uri: ROOT_URI }, replies: "not an array" } },
      { thread: { post: { uri: ROOT_URI }, replies: [null, 7, "x", []] } },
    ]) {
      expect(normalizeThread(body, EXPECTED)).toBeNull();
    }
  });
});

describe("getPostConversation — the page-facing read", () => {
  it("asks the public AppView for one level of replies and no ancestors", async () => {
    const fetcher = okUpstream(threadResponse([reply()]));
    await getPostConversation(REF, { fetcher });
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.origin).toBe("https://public.api.bsky.app");
    expect(url.pathname).toBe("/xrpc/app.bsky.feed.getPostThread");
    expect(url.searchParams.get("uri")).toBe(ROOT_URI);
    expect(url.searchParams.get("depth")).toBe("1");
    expect(url.searchParams.get("parentHeight")).toBe("0");
  });

  it("sends no credentials — this is public, unauthenticated data", async () => {
    const fetcher = okUpstream(threadResponse([reply()]));
    await getPostConversation(REF, { fetcher });
    const init = fetcher.mock.calls[0][1];
    expect(init?.headers).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it("returns the replies plus the thread URL a reader can join at", async () => {
    const result = await getPostConversation(REF, {
      fetcher: okUpstream(threadResponse([reply({ text: "Good piece." })])),
    });
    expect(result?.threadUrl).toBe(THREAD_URL);
    expect(result?.replies.map((r) => r.text)).toEqual(["Good piece."]);
  });
});

describe("getPostConversation — a post with no announcement", () => {
  it("makes no upstream call at all and returns nothing", async () => {
    const fetcher = stubFetch(async () => new Response(null));
    expect(await getPostConversation(undefined, { fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ignores a ref pointing at something that isn't a Bluesky post", async () => {
    const fetcher = stubFetch(async () => new Response(null));
    expect(
      await getPostConversation(
        { uri: `at://${AUTHOR}/site.standard.document/abc` },
        { fetcher },
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ignores a malformed or hostile ref without throwing", async () => {
    const fetcher = stubFetch(async () => new Response(null));
    for (const ref of [
      {},
      { uri: 42 },
      { uri: "not-an-at-uri" },
      { uri: "" },
    ]) {
      expect(await getPostConversation(ref, { fetcher })).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("getPostConversation — when the network misbehaves", () => {
  it("degrades to silence on a 5xx", async () => {
    const fetcher = stubFetch(
      async () => new Response("upstream boom", { status: 502 }),
    );
    expect(await getPostConversation(REF, { fetcher })).toBeNull();
  });

  it("degrades to silence on a rate limit", async () => {
    const fetcher = stubFetch(
      async () => new Response("slow down", { status: 429 }),
    );
    expect(await getPostConversation(REF, { fetcher })).toBeNull();
  });

  it("degrades to silence when the connection fails outright", async () => {
    const fetcher = stubFetch(async () => {
      throw new TypeError("network error");
    });
    await expect(getPostConversation(REF, { fetcher })).resolves.toBeNull();
  });

  it("degrades to silence when the request times out", async () => {
    const fetcher = stubFetch(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    await expect(getPostConversation(REF, { fetcher })).resolves.toBeNull();
  });

  it("passes an abort signal so a hung AppView can't hang the page", async () => {
    const fetcher = okUpstream(threadResponse([reply()]));
    await getPostConversation(REF, { fetcher });
    const init = fetcher.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("degrades to silence on a body that isn't JSON", async () => {
    const fetcher = stubFetch(
      async () =>
        new Response("<html>an error page</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    expect(await getPostConversation(REF, { fetcher })).toBeNull();
  });

  it("refuses an oversized body instead of parsing it", async () => {
    // Declared content-length over the cap: readBodyCapped bails on the fast
    // path, so the 10 ms CPU budget is never spent on it.
    const fetcher = stubFetch(
      async () =>
        new Response(JSON.stringify(threadResponse([reply()])), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "99999999",
          },
        }),
    );
    expect(await getPostConversation(REF, { fetcher })).toBeNull();
  });
});

describe("getPostConversation — edge cache", () => {
  /** Minimal stand-in for the Workers Cache API, keyed by URL string. */
  function fakeCache() {
    const store = new Map<string, Response>();
    return {
      store,
      cache: {
        match: async (key: string) => store.get(key)?.clone(),
        put: async (key: string, res: Response) => {
          store.set(key, res);
        },
      } as unknown as Cache,
    };
  }

  it("serves a second read from the cache without touching the AppView", async () => {
    const { cache } = fakeCache();
    const fetcher = okUpstream(threadResponse([reply({ text: "Cached." })]));

    const first = await getPostConversation(REF, { cache, fetcher });
    const second = await getPostConversation(REF, { cache, fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second?.replies.map((r) => r.text)).toEqual(["Cached."]);
  });

  it("stores the entry publicly and cookie-independently", async () => {
    const { store, cache } = fakeCache();
    await getPostConversation(REF, {
      cache,
      fetcher: okUpstream(threadResponse([reply()])),
    });
    const [key, stored] = [...store.entries()][0];
    // Keyed on the post alone — nothing about the reader is in the key, which
    // is what lets every reader share one cached copy.
    expect(key).toContain(encodeURIComponent(ROOT_URI));
    expect(key).not.toContain("session");
    expect(stored.headers.get("cache-control")).toBe(
      `public, s-maxage=${COMMENTS_CACHE_TTL_SECONDS}`,
    );
    expect(stored.headers.has("set-cookie")).toBe(false);
  });

  it("caches nothing when there is nothing to say", async () => {
    const { store, cache } = fakeCache();
    await getPostConversation(REF, {
      cache,
      fetcher: okUpstream(threadResponse([])),
    });
    expect(store.size).toBe(0);
  });

  it("ignores a corrupt cache entry and re-reads upstream", async () => {
    const { store, cache } = fakeCache();
    const fetcher = okUpstream(threadResponse([reply({ text: "Fresh." })]));
    // Seed the exact key with a junk body, the way a shape change would leave it.
    await getPostConversation(REF, { cache, fetcher });
    const key = [...store.keys()][0];
    store.set(key, new Response("not json at all"));

    const result = await getPostConversation(REF, { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result?.replies.map((r) => r.text)).toEqual(["Fresh."]);
  });

  it("survives a cache that throws on every operation", async () => {
    const broken = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    } as unknown as Cache;
    const result = await getPostConversation(REF, {
      cache: broken,
      fetcher: okUpstream(threadResponse([reply({ text: "Still read." })])),
    });
    expect(result?.replies.map((r) => r.text)).toEqual(["Still read."]);
  });
});
