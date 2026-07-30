// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/import + /api/import/draft handler behavior: session gate, cross-site
 * gate, rate limit, feed resolution (network stubbed at global fetch — the
 * REAL parse pipeline runs), dedupe flags, and the draft+ledger intake
 * semantics. D1 stores are mocked; their SQL-level ownership is pinned in
 * import-store.test.ts.
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

// `batch()` resolves its statements in order, which is what the real one does
// with a list of selects — so the store mocks' resolved rows arrive back in the
// batch response and ~/lib/import-flags' real logic runs over them.
const fakeDb = vi.hoisted(() => ({
  batch: vi.fn(async (queries: unknown[]) => Promise.all(queries)),
}));
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => fakeDb }));

import { MAX_IMPORTS_PER_HOUR } from "../lib/import";
import { signSession } from "../lib/session";
import { Route as ImportRoute } from "../routes/api.import";
import { Route as DraftRoute } from "../routes/api.import.draft";

// The liveness half of the session gate needs a real database, which these
// route suites deliberately don't have — they stub the stores. So the D1 read
// is mocked to "the session is live" and the cookie half runs for real, which
// is what these suites are about. Revocation itself is covered end-to-end in
// live-session.test.ts.
vi.mock("~/lib/live-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-session")>();
  const { readSessionDid } = await import("../lib/session");
  return {
    ...actual,
    readLiveSessionDid: (request: Request, secret: string) =>
      readSessionDid(request, secret),
  };
});

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const importPost = (
  ImportRoute.options as unknown as {
    server: { handlers: { POST: Handler } };
  }
).server.handlers.POST;
const draftPost = (
  DraftRoute.options as unknown as {
    server: { handlers: { POST: Handler } };
  }
).server.handlers.POST;

const DID = "did:plc:fake2222222222writer2222";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers

async function sessionCookie(): Promise<string> {
  return `gr_session=${await signSession(DID, SECRET)}`;
}

async function callImport(body: unknown, authed = true): Promise<Response> {
  return importPost({
    request: new Request("http://127.0.0.1:3000/api/import", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authed ? { cookie: await sessionCookie() } : {}),
      },
    }),
  });
}

async function callDraft(body: unknown, authed = true): Promise<Response> {
  return draftPost({
    request: new Request("http://127.0.0.1:3000/api/import/draft", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authed ? { cookie: await sessionCookie() } : {}),
      },
    }),
  });
}

const LONG_BODY = `<p>${"real words ".repeat(120)}</p>`;
const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Newsletter</title>
<item><title>One</title><link>https://w.example/p/one</link><guid>g-one</guid>
<pubDate>Mon, 06 Jan 2025 12:00:00 GMT</pubDate>
<content:encoded><![CDATA[${LONG_BODY}]]></content:encoded></item>
<item><title>Two</title><link>https://w.example/p/two</link><guid>g-two</guid>
<content:encoded><![CDATA[${LONG_BODY}]]></content:encoded></item>
</channel></rss>`;

function stubFetch(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const handler = routes[String(url)];
      if (!handler) throw new TypeError(`unexpected fetch ${url}`);
      return handler();
    }),
  );
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  for (const fn of Object.values(draftsStore)) fn.mockReset();
  fakeDb.batch.mockClear();
  // Default happy-path plumbing: quota clear, empty ledger, no drafts.
  store.pruneImportFetches.mockResolvedValue(undefined);
  store.countRecentImportFetches.mockResolvedValue([{ n: 0 }]);
  store.insertImportFetch.mockResolvedValue(undefined);
  store.selectImportItems.mockResolvedValue([]);
  store.selectImportItem.mockResolvedValue([]);
  store.selectLiveDraftIds.mockResolvedValue([]);
  store.insertImportItem.mockReturnValue("insert-ledger-query");
  store.reviveImportItem.mockReturnValue("revive-ledger-query");
  draftsStore.countDrafts.mockResolvedValue([{ n: 3 }]);
  draftsStore.insertDraft.mockReturnValue("insert-draft-query");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/import — gates", () => {
  it("401s without a session", async () => {
    const res = await callImport({ url: "https://w.example/feed" }, false);
    expect(res.status).toBe(401);
  });

  it("403s cross-site POSTs", async () => {
    const res = await importPost({
      request: new Request("http://127.0.0.1:3000/api/import", {
        method: "POST",
        body: "{}",
        headers: {
          cookie: await sessionCookie(),
          origin: "https://evil.example",
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("400s junk payloads", async () => {
    expect((await callImport("not json")).status).toBe(400);
    expect((await callImport({ nope: true })).status).toBe(400);
    expect((await callImport({ url: "" })).status).toBe(400);
  });

  it("429s past the hourly quota — before any fetch", async () => {
    stubFetch({}); // any fetch would throw "unexpected fetch"
    store.countRecentImportFetches.mockResolvedValue([
      { n: MAX_IMPORTS_PER_HOUR },
    ]);
    const res = await callImport({ url: "https://w.example/feed" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe(
      "rate_limited",
    );
    expect(store.insertImportFetch).not.toHaveBeenCalled();
  });

  it("400s refused URLs (SSRF guard) without fetching", async () => {
    stubFetch({});
    for (const url of [
      "http://w.example/feed",
      "https://trygoldroad.com/feed",
      "https://127.0.0.1/feed",
    ]) {
      const res = await callImport({ url });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_url",
      );
    }
  });
});

describe("/api/import — feed resolution", () => {
  it("returns items with flags + slots for a direct feed URL", async () => {
    stubFetch({ "https://w.example/feed": () => new Response(FEED_XML) });
    // Item "g-one" was already imported and published.
    store.selectImportItems.mockImplementation(async () => [
      {
        guidHash: await hashOf("g-one"),
        draftId: null,
        publishedRkey: "3lzabc",
      },
    ]);
    const res = await callImport({ url: "https://w.example/feed" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()) as {
      ok: boolean;
      feed: { title: string; url: string };
      draftSlotsRemaining: number;
      items: {
        guid: string;
        alreadyImported: boolean;
        contentHtml: string;
        preview: boolean;
      }[];
    };
    expect(data.ok).toBe(true);
    expect(data.feed.title).toBe("Newsletter");
    expect(data.draftSlotsRemaining).toBe(47); // 50 - 3
    expect(data.items).toHaveLength(2);
    expect(data.items[0].guid).toBe("g-one");
    expect(data.items[0].alreadyImported).toBe(true);
    expect(data.items[1].alreadyImported).toBe(false);
    expect(data.items[0].contentHtml).toContain("real words");
  });

  it("autodiscovers the feed behind an HTML page", async () => {
    const html = `<!doctype html><html><head>
      <link rel="alternate" type="application/rss+xml" href="/the-feed.xml">
      </head><body>blog</body></html>`;
    stubFetch({
      "https://w.example/": () => new Response(html),
      "https://w.example/the-feed.xml": () => new Response(FEED_XML),
    });
    const res = await callImport({ url: "https://w.example/" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { feed: { url: string } };
    expect(data.feed.url).toBe("https://w.example/the-feed.xml");
  });

  it("422s when nothing answers with a feed", async () => {
    const html = "<!doctype html><html><body>no feeds here</body></html>";
    stubFetch({
      "https://w.example/": () => new Response(html),
      "https://w.example/feed": () => new Response(html),
      "https://w.example/rss/": () => new Response(html),
    });
    const res = await callImport({ url: "https://w.example/" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("not_a_feed");
  });

  it("maps an upstream 429 to upstream_blocked (Substack refuses our egress)", async () => {
    stubFetch({
      "https://writer.substack.com/feed": () =>
        new Response("Too Many Requests", { status: 429 }),
    });
    const res = await callImport({ url: "https://writer.substack.com/feed" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "upstream_blocked",
    );
  });

  it("502s when the host is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("down");
      }),
    );
    const res = await callImport({ url: "https://w.example/feed" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "fetch_failed",
    );
  });

  it("a cleared row (published post later deleted) is NOT flagged as imported", async () => {
    stubFetch({ "https://w.example/feed": () => new Response(FEED_XML) });
    // clearPublishedImport left the row with no draft and no rkey.
    store.selectImportItems.mockImplementation(async () => [
      { guidHash: await hashOf("g-one"), draftId: null, publishedRkey: null },
    ]);
    const res = await callImport({ url: "https://w.example/feed" });
    const data = (await res.json()) as {
      items: { alreadyImported: boolean }[];
    };
    expect(data.items[0].alreadyImported).toBe(false);
  });

  it("does not count a still-live-draft check as imported when the draft is gone", async () => {
    stubFetch({ "https://w.example/feed": () => new Response(FEED_XML) });
    // Ledger row exists for g-one, unpublished, pointing at a DELETED draft.
    store.selectImportItems.mockImplementation(async () => [
      {
        guidHash: await hashOf("g-one"),
        draftId: "11111111-2222-3333-4444-555555555555",
        publishedRkey: null,
      },
    ]);
    store.selectLiveDraftIds.mockResolvedValue([]); // draft no longer exists
    const res = await callImport({ url: "https://w.example/feed" });
    const data = (await res.json()) as {
      items: { alreadyImported: boolean }[];
    };
    expect(data.items[0].alreadyImported).toBe(false);
  });
});

async function hashOf(guid: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(guid),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DRAFT_PAYLOAD = {
  title: "One",
  content: [{ type: "paragraph", content: [] }],
  source: {
    guid: "g-one",
    link: "https://w.example/p/one",
    publishedAt: "2025-01-06T12:00:00.000Z",
  },
};

describe("/api/import/draft — intake", () => {
  it("401s without a session; 403s cross-site", async () => {
    expect((await callDraft(DRAFT_PAYLOAD, false)).status).toBe(401);
    const res = await draftPost({
      request: new Request("http://127.0.0.1:3000/api/import/draft", {
        method: "POST",
        body: JSON.stringify(DRAFT_PAYLOAD),
        headers: {
          cookie: await sessionCookie(),
          origin: "https://evil.example",
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("400s bad payloads (missing source, junk dates, javascript: links)", async () => {
    expect((await callDraft({ title: "x", content: [] })).status).toBe(400);
    expect(
      (
        await callDraft({
          ...DRAFT_PAYLOAD,
          source: { guid: "g", publishedAt: "yesterday-ish" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await callDraft({
          ...DRAFT_PAYLOAD,
          source: { guid: "g", link: "javascript:alert(1)" },
        })
      ).status,
    ).toBe(400);
  });

  it("saves the draft + ledger row in one batch and returns 201", async () => {
    const res = await callDraft(DRAFT_PAYLOAD);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { ok: boolean; draft: { id: string } };
    expect(data.ok).toBe(true);
    expect(data.draft.id).toMatch(/^[0-9a-f-]{36}$/);
    // Atomic pair: the batch carried the draft insert AND the ledger insert.
    expect(fakeDb.batch).toHaveBeenCalledWith([
      "insert-draft-query",
      "insert-ledger-query",
    ]);
    const inserted = store.insertImportItem.mock.calls[0][1];
    expect(inserted.did).toBe(DID);
    expect(inserted.guidHash).toBe(await hashOf("g-one"));
    expect(inserted.sourceUrl).toBe("https://w.example/p/one");
    // The DRAFT row is keyed to the session DID, never anything client-sent.
    expect(draftsStore.insertDraft.mock.calls[0][1].did).toBe(DID);
  });

  it("409s already_imported for published items", async () => {
    store.selectImportItem.mockResolvedValue([
      { publishedRkey: "3lzabc", draftId: null },
    ]);
    const res = await callDraft(DRAFT_PAYLOAD);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("already_imported");
    expect(fakeDb.batch).not.toHaveBeenCalled();
  });

  it("409s already_imported when the item's draft is still live", async () => {
    store.selectImportItem.mockResolvedValue([
      {
        publishedRkey: null,
        draftId: "11111111-2222-3333-4444-555555555555",
      },
    ]);
    store.selectLiveDraftIds.mockResolvedValue([
      { id: "11111111-2222-3333-4444-555555555555" },
    ]);
    const res = await callDraft(DRAFT_PAYLOAD);
    expect(res.status).toBe(409);
  });

  it("revives the ledger row when the earlier draft was discarded", async () => {
    store.selectImportItem.mockResolvedValue([
      {
        publishedRkey: null,
        draftId: "11111111-2222-3333-4444-555555555555",
      },
    ]);
    store.selectLiveDraftIds.mockResolvedValue([]); // discarded
    const res = await callDraft(DRAFT_PAYLOAD);
    expect(res.status).toBe(201);
    expect(fakeDb.batch).toHaveBeenCalledWith([
      "insert-draft-query",
      "revive-ledger-query",
    ]);
    expect(store.insertImportItem).not.toHaveBeenCalled();
  });

  it("409s draft_limit at the cap", async () => {
    draftsStore.countDrafts.mockResolvedValue([{ n: 50 }]);
    const res = await callDraft(DRAFT_PAYLOAD);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("draft_limit");
  });

  it("clamps future original dates (no future-sorting TIDs downstream)", async () => {
    await callDraft({
      ...DRAFT_PAYLOAD,
      source: { ...DRAFT_PAYLOAD.source, publishedAt: "2099-01-01T00:00:00Z" },
    });
    const inserted = store.insertImportItem.mock.calls[0][1];
    expect(inserted.originalAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
