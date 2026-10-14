// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/threads + /api/threads/assemble handler behavior: the session gate, the
 * cross-site gate, the thread-kind rate limit, the "only your own posts" gate,
 * the ledger's already-imported flags, and the assembly refusals.
 *
 * Network is stubbed at global fetch — the REAL reduction in ~/lib/threads
 * runs, so what these tests pin is the handler's contract over genuine
 * conversion output rather than over a mocked answer. D1 stores are mocked;
 * their SQL-level ownership is pinned in import-store.test.ts.
 *
 * Same construction as api-import-route.test.ts, deliberately: these are two
 * doors onto one intake and their guards should be legible side by side.
 */
const store = vi.hoisted(() => ({
  selectImportItems: vi.fn(),
  selectImportItem: vi.fn(),
  selectImportItemByDraft: vi.fn(),
  selectMirror: vi.fn(),
  insertImportItem: vi.fn(),
  reviveImportItem: vi.fn(),
  setPublishedRkey: vi.fn(),
  adoptMirror: vi.fn(),
  selectLiveDraftIds: vi.fn(),
  countRecentImportFetches: vi.fn(),
  insertImportFetch: vi.fn(),
  pruneImportFetches: vi.fn(),
}));
vi.mock("~/lib/import-store", () => store);

const draftsStore = vi.hoisted(() => ({
  countDrafts: vi.fn(),
  insertDraft: vi.fn(),
}));
vi.mock("~/lib/drafts", () => draftsStore);

const fakeDb = vi.hoisted(() => ({
  batch: vi.fn(async (queries: unknown[]) => Promise.all(queries)),
}));
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => fakeDb }));

// No Workers Cache in a node test run — the route's feature detection has to
// take the "no cache at all" branch, which is also the self-hosting case.
vi.mock("~/lib/workers-cache", () => ({ defaultCache: () => null }));

import { signSession } from "../lib/session";
import { MAX_THREAD_FETCHES_PER_HOUR } from "../lib/threads";
import { Route as ThreadsRoute } from "../routes/api.threads";
import { Route as AssembleRoute } from "../routes/api.threads.assemble";
import { handlerOf } from "./support/route-handler";

// Same reason as api-import-route.test.ts: the liveness half of the session gate
// needs a real database these suites deliberately don't have, so the D1 read is
// mocked to "live" and the cookie half runs for real. Revocation itself is
// covered end-to-end in live-session.test.ts.
vi.mock("~/lib/live-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-session")>();
  const { readSessionDid } = await import("../lib/session");
  return {
    ...actual,
    readLiveSessionDid: (request: Request, secret: string) =>
      readSessionDid(request, secret),
  };
});

const threadsPost = handlerOf(ThreadsRoute, "POST");
const assemblePost = handlerOf(AssembleRoute, "POST");

const DID = "did:plc:fake2222222222writer2222";
const OTHER = "did:plc:fake3333333333reader3333";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers

async function sessionCookie(): Promise<string> {
  return `gr_session=${await signSession(DID, SECRET)}`;
}

function uri(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

async function callThreads(authed = true): Promise<Response> {
  return threadsPost({
    request: new Request("http://127.0.0.1:3000/api/threads", {
      method: "POST",
      headers: authed ? { cookie: await sessionCookie() } : {},
    }),
  });
}

async function callAssemble(body: unknown, authed = true): Promise<Response> {
  return assemblePost({
    request: new Request("http://127.0.0.1:3000/api/threads/assemble", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authed ? { cookie: await sessionCookie() } : {}),
      },
    }),
  });
}

function postView(opts: {
  did?: string;
  rkey: string;
  text: string;
  createdAt?: string;
  parent?: string;
}) {
  const did = opts.did ?? DID;
  return {
    uri: uri(did, opts.rkey),
    cid: `cid-${opts.rkey}`,
    author: { did, handle: "me.example" },
    record: {
      $type: "app.bsky.feed.post",
      createdAt: opts.createdAt ?? "2026-02-04T10:00:00.000Z",
      text: opts.text,
      ...(opts.parent
        ? {
            reply: {
              parent: { uri: opts.parent, cid: "c" },
              root: { uri: opts.parent, cid: "c" },
            },
          }
        : {}),
    },
    indexedAt: "2026-02-04T10:00:01.000Z",
  };
}

/** One thread of two posts, in both the feed and the thread shapes. */
const FEED_BODY = {
  feed: [
    {
      post: postView({
        rkey: "3aa2",
        text: "the second post",
        parent: uri(DID, "3aa1"),
        createdAt: "2026-02-04T10:01:00.000Z",
      }),
    },
    { post: postView({ rkey: "3aa1", text: "On leaving" }) },
  ],
  cursor: null,
};

const THREAD_BODY = {
  thread: {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: postView({ rkey: "3aa1", text: "On leaving" }),
    replies: [
      {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: postView({
          rkey: "3aa2",
          text: "the second post",
          parent: uri(DID, "3aa1"),
          createdAt: "2026-02-04T10:01:00.000Z",
        }),
        replies: [],
      },
    ],
  },
};

/** Answers every AppView GET with one body, and records the URLs asked for. */
function stubAppView(body: unknown, status = 200) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return seen;
}

async function hashOf(guid: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(guid),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  for (const fn of Object.values(draftsStore)) fn.mockReset();
  fakeDb.batch.mockClear();
  store.pruneImportFetches.mockResolvedValue(undefined);
  store.countRecentImportFetches.mockResolvedValue([{ n: 0 }]);
  store.insertImportFetch.mockResolvedValue(undefined);
  store.selectImportItems.mockResolvedValue([]);
  store.selectLiveDraftIds.mockResolvedValue([]);
  draftsStore.countDrafts.mockResolvedValue([{ n: 3 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/threads — gates", () => {
  it("401s without a session", async () => {
    expect((await callThreads(false)).status).toBe(401);
  });

  it("403s cross-site POSTs", async () => {
    const res = await threadsPost({
      request: new Request("http://127.0.0.1:3000/api/threads", {
        method: "POST",
        headers: {
          cookie: await sessionCookie(),
          origin: "https://evil.example",
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("429s past the thread quota — before any fetch", async () => {
    const seen = stubAppView(FEED_BODY);
    store.countRecentImportFetches.mockResolvedValue([
      { n: MAX_THREAD_FETCHES_PER_HOUR },
    ]);
    const res = await callThreads();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe(
      "rate_limited",
    );
    expect(seen).toEqual([]);
    expect(store.insertImportFetch).not.toHaveBeenCalled();
  });

  it("spends the THREAD budget, never the feed importer's", async () => {
    stubAppView(FEED_BODY);
    await callThreads();
    expect(store.countRecentImportFetches.mock.calls[0][3]).toBe("thread");
    expect(store.insertImportFetch.mock.calls[0][2]).toBe("thread");
  });

  it("502s when the AppView refuses", async () => {
    stubAppView({}, 503);
    const res = await callThreads();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "appview_failed",
    );
  });
});

describe("/api/threads — the list", () => {
  it("lists the writer's threads with slots and ledger flags", async () => {
    stubAppView(FEED_BODY);
    const res = await callThreads();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const data = (await res.json()) as {
      ok: boolean;
      truncated: boolean;
      draftSlotsRemaining: number;
      threads: {
        rootUri: string;
        guidHash: string;
        title: string;
        postCount: number;
        alreadyImported: boolean;
      }[];
    };
    expect(data.ok).toBe(true);
    expect(data.draftSlotsRemaining).toBe(47); // 50 - 3
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].rootUri).toBe(uri(DID, "3aa1"));
    expect(data.threads[0].title).toBe("On leaving");
    expect(data.threads[0].postCount).toBe(2);
    expect(data.threads[0].alreadyImported).toBe(false);
    // The ledger key is a hash of the ROOT URI, not of anything client-sent.
    expect(data.threads[0].guidHash).toBe(await hashOf(uri(DID, "3aa1")));
  });

  it("flags a thread already published from the ledger", async () => {
    stubAppView(FEED_BODY);
    store.selectImportItems.mockImplementation(async () => [
      {
        guidHash: await hashOf(uri(DID, "3aa1")),
        draftId: null,
        publishedRkey: "3lzabc",
      },
    ]);
    const res = await callThreads();
    const data = (await res.json()) as {
      threads: { alreadyImported: boolean }[];
    };
    expect(data.threads[0].alreadyImported).toBe(true);
  });

  it("a discarded draft does NOT count as imported — re-importing is the way back", async () => {
    stubAppView(FEED_BODY);
    store.selectImportItems.mockImplementation(async () => [
      {
        guidHash: await hashOf(uri(DID, "3aa1")),
        draftId: "11111111-2222-3333-4444-555555555555",
        publishedRkey: null,
      },
    ]);
    store.selectLiveDraftIds.mockResolvedValue([]); // draft gone
    const res = await callThreads();
    const data = (await res.json()) as {
      threads: { alreadyImported: boolean }[];
    };
    expect(data.threads[0].alreadyImported).toBe(false);
  });

  it("reads the SESSION's own feed and nothing a caller could name", async () => {
    const seen = stubAppView(FEED_BODY);
    await callThreads();
    for (const url of seen) {
      const parsed = new URL(url);
      expect(parsed.host).toBe("public.api.bsky.app");
      expect(parsed.searchParams.get("actor")).toBe(DID);
    }
  });
});

describe("/api/threads/assemble — gates", () => {
  it("401s without a session; 403s cross-site", async () => {
    expect(
      (await callAssemble({ rootUri: uri(DID, "3aa1") }, false)).status,
    ).toBe(401);
    const res = await assemblePost({
      request: new Request("http://127.0.0.1:3000/api/threads/assemble", {
        method: "POST",
        body: JSON.stringify({ rootUri: uri(DID, "3aa1") }),
        headers: {
          cookie: await sessionCookie(),
          origin: "https://evil.example",
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("400s junk payloads", async () => {
    expect((await callAssemble("not json")).status).toBe(400);
    expect((await callAssemble({})).status).toBe(400);
    expect((await callAssemble({ rootUri: "" })).status).toBe(400);
  });

  it("403s a URI that is not the session's own post — without fetching", async () => {
    const seen = stubAppView(THREAD_BODY);
    for (const rootUri of [
      uri(OTHER, "3aa1"), // somebody else's thread
      `at://${DID}/app.bsky.feed.like/3aa1`, // not a post
      "https://bsky.app/profile/me.example/post/3aa1", // not an at:// URI
    ]) {
      const res = await callAssemble({ rootUri });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "not_your_post",
      );
    }
    expect(seen).toEqual([]);
  });

  it("429s past the thread quota, sharing the budget with discovery", async () => {
    const seen = stubAppView(THREAD_BODY);
    store.countRecentImportFetches.mockResolvedValue([
      { n: MAX_THREAD_FETCHES_PER_HOUR },
    ]);
    const res = await callAssemble({ rootUri: uri(DID, "3aa1") });
    expect(res.status).toBe(429);
    expect(store.countRecentImportFetches.mock.calls[0][3]).toBe("thread");
    expect(seen).toEqual([]);
  });
});

describe("/api/threads/assemble — the conversion", () => {
  it("returns the assembled thread, its date and its provenance link", async () => {
    stubAppView(THREAD_BODY);
    const res = await callAssemble({ rootUri: uri(DID, "3aa1") });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      thread: {
        title: string;
        markdown: string;
        postCount: number;
        createdAt: string;
        sourceUrl: string;
      };
    };
    expect(data.ok).toBe(true);
    expect(data.thread.title).toBe("On leaving");
    expect(data.thread.markdown).toBe("On leaving\n\nthe second post");
    expect(data.thread.postCount).toBe(2);
    // Backdated to the ROOT's own date — the thread's beginning, not its end.
    expect(data.thread.createdAt).toBe("2026-02-04T10:00:00.000Z");
    expect(data.thread.sourceUrl).toBe(
      `https://bsky.app/profile/${DID}/post/3aa1`,
    );
  });

  it("asks the fixed AppView host for the thread it was given", async () => {
    const seen = stubAppView(THREAD_BODY);
    await callAssemble({ rootUri: uri(DID, "3aa1") });
    const url = new URL(seen[0]);
    expect(url.host).toBe("public.api.bsky.app");
    expect(url.pathname).toBe("/xrpc/app.bsky.feed.getPostThread");
    expect(url.searchParams.get("uri")).toBe(uri(DID, "3aa1"));
  });

  it("422s a lone post, a deleted root and a blocked root alike", async () => {
    for (const body of [
      {
        thread: {
          $type: "app.bsky.feed.defs#threadViewPost",
          post: postView({ rkey: "3aa1", text: "alone" }),
          replies: [],
        },
      },
      { thread: { $type: "app.bsky.feed.defs#notFoundPost", notFound: true } },
      { thread: { $type: "app.bsky.feed.defs#blockedPost", blocked: true } },
    ]) {
      stubAppView(body);
      const res = await callAssemble({ rootUri: uri(DID, "3aa1") });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe(
        "not_a_thread",
      );
      vi.unstubAllGlobals();
    }
  });

  it("502s when the AppView flakes", async () => {
    stubAppView({}, 500);
    const res = await callAssemble({ rootUri: uri(DID, "3aa1") });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "appview_failed",
    );
  });

  it("413s a thread too long for a document body, rather than cutting it", async () => {
    // Forty posts each at the lexicon's own 3000-character ceiling — 120k, past
    // MAX_BODY_LENGTH. (A single huge post can't get there: normalizePost clamps
    // every post's text to 3000, so the only way past the body cap is length.)
    const long = "x".repeat(3_000);
    const POSTS = 40;
    let deepest: unknown = {
      $type: "app.bsky.feed.defs#threadViewPost",
      post: postView({
        rkey: `3bb${POSTS}`,
        text: long,
        parent: uri(DID, `3bb${POSTS - 1}`),
        createdAt: "2026-02-05T00:00:00.000Z",
      }),
      replies: [],
    };
    for (let i = POSTS - 1; i >= 2; i--) {
      deepest = {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: postView({
          rkey: `3bb${i}`,
          text: long,
          parent: uri(DID, `3bb${i - 1}`),
          createdAt: `2026-02-04T${String(i % 24).padStart(2, "0")}:10:00.000Z`,
        }),
        replies: [deepest],
      };
    }
    stubAppView({
      thread: {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: postView({ rkey: "3bb1", text: long }),
        replies: [deepest],
      },
    });
    const res = await callAssemble({ rootUri: uri(DID, "3bb1") });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("too_long");
  });

  it("writes nothing anywhere — assembly is a read", async () => {
    stubAppView(THREAD_BODY);
    await callAssemble({ rootUri: uri(DID, "3aa1") });
    expect(store.insertImportItem).not.toHaveBeenCalled();
    expect(store.reviveImportItem).not.toHaveBeenCalled();
    expect(draftsStore.insertDraft).not.toHaveBeenCalled();
    expect(fakeDb.batch).not.toHaveBeenCalled();
  });
});
