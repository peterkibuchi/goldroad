// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCacheableReadRequest,
  purgeLocalReadCache,
  READ_CACHE_CONTROL,
  READ_CACHE_TTL_SECONDS,
  readCacheKey,
  readSurfaceUrlsForSubject,
  readSurfaceWarmUrls,
  serveWithReadCache,
  takeWarmTargets,
  WARM_TARGETS_HEADER,
  warmReadSurfaces,
  withWarmTargets,
} from "../lib/read-cache";

/** Minimal Workers-cache stand-in over a Map (mirrors img-route.test.ts). */
function mockCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (url: URL | string) => store.get(String(url))),
    put: vi.fn(async (url: URL | string, res: Response) => {
      store.set(String(url), res);
    }),
    delete: vi.fn(async (url: URL | string) => store.delete(String(url))),
    store,
  };
  vi.stubGlobal("caches", { default: cache });
  return cache;
}

function htmlResponse(body = "<!doctype html><title>ok</title>") {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const req = (path: string, init?: RequestInit) =>
  new Request(`https://trygoldroad.com${path}`, init);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isCacheableReadRequest", () => {
  it("matches GETs to reading surfaces only", () => {
    expect(isCacheableReadRequest(req("/@awarm.space"))).toBe(true);
    expect(isCacheableReadRequest(req("/@awarm.space/3lyk73wxnok2f"))).toBe(
      true,
    );
    expect(isCacheableReadRequest(req("/p/awarm.space/3lyk73wxnok2f"))).toBe(
      true,
    );
    // The publication RSS feed lives under /@… and gets the same treatment.
    expect(isCacheableReadRequest(req("/@awarm.space/rss.xml"))).toBe(true);
  });

  it("never caches the marketing, app, api, or img paths", () => {
    for (const path of [
      "/",
      "/write",
      "/dashboard",
      "/settings",
      "/privacy",
      "/policies",
      "/api/waitlist",
      "/img/did:plc:x/bafy",
      "/login",
    ]) {
      expect(isCacheableReadRequest(req(path)), path).toBe(false);
    }
  });

  it("caches reading surfaces regardless of cookie (never personalized)", () => {
    // The DoS mitigation must not be dodgeable by sending a session cookie.
    expect(
      isCacheableReadRequest(
        req("/@awarm.space", { headers: { cookie: "gr_session=x" } }),
      ),
    ).toBe(true);
  });

  it("never caches non-GET methods", () => {
    expect(
      isCacheableReadRequest(req("/@awarm.space", { method: "POST" })),
    ).toBe(false);
  });
});

describe("readCacheKey — normalization", () => {
  it("strips every query param except a valid cursor (anti-pollution)", () => {
    expect(readCacheKey(req("/@h?x=random&y=1"))).toBe(
      "https://trygoldroad.com/@h",
    );
    expect(readCacheKey(req("/@h?cursor=3lyk73wxnok2f&x=junk"))).toBe(
      "https://trygoldroad.com/@h?cursor=3lyk73wxnok2f",
    );
  });

  it("drops a malformed cursor rather than keying on it", () => {
    // A control char fails isValidCursor → treated as no cursor.
    expect(readCacheKey(req("/@h?cursor=%00bad"))).toBe(
      "https://trygoldroad.com/@h",
    );
  });

  it("ignores the cursor on paths that don't paginate", () => {
    // `isValidCursor` is shape-only, so keying on the param anywhere it appears
    // lets a stranger mint unlimited distinct MISSes for identical bytes. The
    // feed is the worst place for that — it is the most expensive handler here.
    expect(readCacheKey(req("/@h/rss.xml?cursor=3lyk73wxnok2f"))).toBe(
      "https://trygoldroad.com/@h/rss.xml",
    );
    expect(readCacheKey(req("/@h/3lyk73wxnok2f?cursor=3lyk73wxnok2f"))).toBe(
      "https://trygoldroad.com/@h/3lyk73wxnok2f",
    );
    expect(readCacheKey(req("/p/abc?cursor=3lyk73wxnok2f"))).toBe(
      "https://trygoldroad.com/p/abc",
    );
  });

  it("still keys on the cursor for the page that paginates", () => {
    // With or without the trailing slash — the "Older posts" link.
    expect(readCacheKey(req("/@h/?cursor=3lyk73wxnok2f"))).toBe(
      "https://trygoldroad.com/@h/?cursor=3lyk73wxnok2f",
    );
  });
});

describe("serveWithReadCache — HIT/MISS flow", () => {
  it("misses then hits, invoking the loader exactly once", async () => {
    const cache = mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());

    const miss = await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    expect(miss.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(miss.headers.get("cache-control")).toBe(READ_CACHE_CONTROL);
    expect(await miss.text()).toContain("<title>ok</title>");

    const hit = await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    expect(hit.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(await hit.text()).toContain("<title>ok</title>");

    expect(fetchFresh).toHaveBeenCalledTimes(1); // the hit never re-ran the loader
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("collapses `?x=random` onto the same key (no MISS pollution)", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    await serveWithReadCache(req("/@awarm.space?x=1"), fetchFresh);
    await serveWithReadCache(req("/@awarm.space?x=2"), fetchFresh);
    expect(fetchFresh).toHaveBeenCalledTimes(1); // all share the /@awarm.space key
  });

  it("varies the key on a valid pagination cursor", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    await serveWithReadCache(
      req("/@awarm.space?cursor=3lyk73wxnok2f"),
      fetchFresh,
    );
    expect(fetchFresh).toHaveBeenCalledTimes(2); // distinct pages, distinct keys
  });

  it("serves from cache even when the request carries a cookie", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serveWithReadCache(req("/@awarm.space"), fetchFresh); // warm
    const withCookie = await serveWithReadCache(
      req("/@awarm.space", { headers: { cookie: "gr_session=x" } }),
      fetchFresh,
    );
    expect(withCookie.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("never caches a 404 or an upstream flake", async () => {
    const cache = mockCache();
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const res = await serveWithReadCache(req("/@ghost.invalid"), notFound);
    expect(res.status).toBe(404);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("never caches a response that sets a cookie", async () => {
    const cache = mockCache();
    const withCookie = vi.fn(async () => {
      const r = htmlResponse();
      r.headers.set("set-cookie", "gr_session=x");
      return r;
    });
    await serveWithReadCache(req("/@awarm.space"), withCookie);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("falls through untouched when the Cache API is absent (node/tests)", async () => {
    // no mockCache(): caches.default is undefined
    const fetchFresh = vi.fn(async () => htmlResponse());
    const res = await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    expect(res.headers.get("x-goldroad-cache")).toBeNull();
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("caches RSS feed responses like the HTML surfaces (miss → hit)", async () => {
    const cache = mockCache();
    const fetchFresh = vi.fn(
      async () =>
        new Response('<?xml version="1.0"?><rss/>', {
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8" },
        }),
    );
    const miss = await serveWithReadCache(
      req("/@awarm.space/rss.xml"),
      fetchFresh,
    );
    expect(miss.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(miss.headers.get("cache-control")).toBe(READ_CACHE_CONTROL);

    const hit = await serveWithReadCache(
      req("/@awarm.space/rss.xml"),
      fetchFresh,
    );
    expect(hit.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(await hit.text()).toContain("<rss/>");
    expect(fetchFresh).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("never stores a content type outside the allowlist, even on a read path", async () => {
    const cache = mockCache();
    const json = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await serveWithReadCache(req("/@awarm.space/rss.xml"), json);
    expect(res.status).toBe(200);
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe("READ_CACHE_TTL_SECONDS — the raised window", () => {
  it("holds reading surfaces for 5 minutes, not one", () => {
    // 60 s was chosen so a takedown re-checked within a minute WITHOUT a purge.
    // Raising it is only defensible because the purge path below exists; if this
    // number ever climbs again, that argument has to be re-made.
    expect(READ_CACHE_TTL_SECONDS).toBe(300);
    expect(READ_CACHE_CONTROL).toContain("s-maxage=300");
  });
});

describe("readSurfaceUrlsForSubject — the takedown purge list", () => {
  const ORIGIN = "https://trygoldroad.com";
  const DID = "did:plc:ukp7pzzht32uigg6bg4vxr5t";
  const RKEY = "3lyk73wxnok2f";
  const AT_URI = `at://${DID}/site.standard.document/${RKEY}`;

  it("covers every page a taken-down RECORD can be showing on", () => {
    const urls = readSurfaceUrlsForSubject(ORIGIN, AT_URI, "writer.example");
    // Both reader URL shapes, in the handle spelling a shared link uses…
    expect(urls).toContain(`${ORIGIN}/@writer.example/${RKEY}`);
    expect(urls).toContain(`${ORIGIN}/p/writer.example/${RKEY}`);
    // …and in the DID spelling, which these routes accept just as happily.
    expect(urls).toContain(`${ORIGIN}/@${DID}/${RKEY}`);
    expect(urls).toContain(`${ORIGIN}/p/${DID}/${RKEY}`);
    // The archive index and the feed both LIST the record, so both go too.
    expect(urls).toContain(`${ORIGIN}/@writer.example`);
    expect(urls).toContain(`${ORIGIN}/@writer.example/rss.xml`);
  });

  it("covers the percent-encoded DID spelling as well as the raw one", () => {
    // Our own links mint `encodeURIComponent(ident)`, so the colons arrive
    // escaped; a crawled or hand-typed URL arrives raw. `URL` normalizes
    // neither into the other, so they are two cache keys and both must go.
    const urls = readSurfaceUrlsForSubject(ORIGIN, AT_URI);
    expect(urls).toContain(`${ORIGIN}/@${encodeURIComponent(DID)}/${RKEY}`);
    expect(urls).toContain(`${ORIGIN}/@${DID}/${RKEY}`);
  });

  it("covers the archive index with AND without its trailing slash", () => {
    // `/@h` and `/@h/` are different paths and readCacheKey keeps them apart.
    const urls = readSurfaceUrlsForSubject(ORIGIN, DID, "writer.example");
    expect(urls).toContain(`${ORIGIN}/@writer.example`);
    expect(urls).toContain(`${ORIGIN}/@writer.example/`);
  });

  it("purges every key readCacheKey could have stored the page under", () => {
    // The invariant that makes the purge trustworthy: the list is built by one
    // function and the keys by another, and a drift between them would mean a
    // takedown silently leaving pages served. Pin them against each other.
    const urls = new Set(
      readSurfaceUrlsForSubject(ORIGIN, AT_URI, "writer.example"),
    );
    const servedPaths = [
      `/@writer.example/${RKEY}`,
      `/p/writer.example/${RKEY}`,
      `/@${DID}/${RKEY}`,
      `/@${encodeURIComponent(DID)}/${RKEY}`,
      "/@writer.example",
      "/@writer.example/",
      "/@writer.example/rss.xml",
    ];
    for (const path of servedPaths) {
      expect(urls, path).toContain(readCacheKey(req(path)));
    }
  });

  it("refuses to guess: a malformed or foreign subject purges nothing", () => {
    expect(readSurfaceUrlsForSubject(ORIGIN, "not-a-did")).toEqual([]);
    expect(readSurfaceUrlsForSubject(ORIGIN, "")).toEqual([]);
    // A record in a collection these routes never render addresses no page.
    expect(
      readSurfaceUrlsForSubject(
        ORIGIN,
        `at://${DID}/app.bsky.feed.post/${RKEY}`,
      ),
    ).toEqual([]);
  });

  it("skips the handle spelling when the handle is unknown or malformed", () => {
    const urls = readSurfaceUrlsForSubject(ORIGIN, DID, "not a handle");
    expect(urls.some((u) => u.includes("not%20a%20handle"))).toBe(false);
    expect(urls).toContain(`${ORIGIN}/@${DID}`);
  });
});

describe("purgeLocalReadCache", () => {
  it("makes a warm page miss again, and counts only what was there", async () => {
    const cache = mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serveWithReadCache(req("/@awarm.space"), fetchFresh); // warm it

    const purged = await purgeLocalReadCache([
      "https://trygoldroad.com/@awarm.space",
      "https://trygoldroad.com/@never.cached",
    ]);
    expect(purged).toBe(1); // the second key was never stored
    expect(cache.delete).toHaveBeenCalledTimes(2);

    const after = await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    expect(after.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(fetchFresh).toHaveBeenCalledTimes(2); // it really re-ran the loader
  });

  it("is a no-op without the Cache API, rather than throwing", async () => {
    // No mockCache(): unit tests and any non-Workers runtime have no cache.
    await expect(
      purgeLocalReadCache(["https://trygoldroad.com/@h"]),
    ).resolves.toBe(0);
  });
});

describe("warmReadSurfaces", () => {
  it("deletes before fetching, so an already-cached page is really re-rendered", async () => {
    const cache = mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse("<!doctype html>old"));
    await serveWithReadCache(req("/@awarm.space"), fetchFresh); // stale entry

    // A plain fetch of a warm URL is a HIT that re-stores nothing — which is
    // precisely the after-an-edit case. The delete is what makes this a refresh.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      serveWithReadCache(new Request(String(input)), async () =>
        htmlResponse("<!doctype html>new"),
      ),
    );
    await warmReadSurfaces(["https://trygoldroad.com/@awarm.space"], {
      origin: "https://trygoldroad.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(cache.delete).toHaveBeenCalledWith(
      "https://trygoldroad.com/@awarm.space",
    );
    const served = await serveWithReadCache(req("/@awarm.space"), fetchFresh);
    expect(served.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(await served.text()).toContain("new");
  });

  it("never fetches a URL off our own origin", async () => {
    mockCache();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      htmlResponse(),
    );
    await warmReadSurfaces(
      ["https://evil.example/@h", "https://trygoldroad.com/@h"],
      {
        origin: "https://trygoldroad.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://trygoldroad.com/@h",
    );
  });

  it("swallows a failed warm — a cold render is the status quo, not an error", async () => {
    mockCache();
    const fetchImpl = vi.fn(async () => {
      throw new Error("upstream down");
    });
    await expect(
      warmReadSurfaces(["https://trygoldroad.com/@h"], {
        origin: "https://trygoldroad.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * The list itself, now that two callers reach the warm by different roads: the
 * request path stamps these onto a response header for the entry to pick up,
 * and the cron — which has no response — calls warmReadSurfaces with them
 * directly. One function, so the two cannot drift.
 */
describe("readSurfaceWarmUrls — what one document write changes", () => {
  it("names the archive index and the document's own page", () => {
    expect(
      readSurfaceWarmUrls({
        origin: "https://trygoldroad.com",
        ident: "writer.example",
        rkey: "3lyk73wxnok2f",
      }),
    ).toEqual([
      "https://trygoldroad.com/@writer.example",
      "https://trygoldroad.com/@writer.example/3lyk73wxnok2f",
    ]);
  });

  it("names the index alone when no record is involved", () => {
    expect(
      readSurfaceWarmUrls({
        origin: "https://trygoldroad.com",
        ident: "writer.example",
      }),
    ).toEqual(["https://trygoldroad.com/@writer.example"]);
  });

  it("encodes a DID ident the way our own links mint it", () => {
    // `/@did%3Aplc%3A…` is the key the page is cached under when a handle
    // won't resolve; the raw form is a different cache key entirely.
    const [index] = readSurfaceWarmUrls({
      origin: "https://trygoldroad.com",
      ident: "did:plc:fake2222222222writer2222",
    });
    expect(index).toBe(
      "https://trygoldroad.com/@did%3Aplc%3Afake2222222222writer2222",
    );
  });
});

describe("warm-target header plumbing", () => {
  it("round-trips the URL list from the handler to the entry", () => {
    const stamped = withWarmTargets(new Response(null, { status: 303 }), [
      "https://trygoldroad.com/@h",
      "https://trygoldroad.com/@h/3lyk73wxnok2f",
    ]);
    const { urls } = takeWarmTargets(stamped);
    expect(urls).toEqual([
      "https://trygoldroad.com/@h",
      "https://trygoldroad.com/@h/3lyk73wxnok2f",
    ]);
  });

  it("STRIPS the header before the response leaves", () => {
    // The one that matters: a leaked internal header would tell every visitor
    // which URLs we consider interesting, and it is invisible in a browser.
    const stamped = withWarmTargets(new Response(null, { status: 303 }), [
      "https://trygoldroad.com/@h",
    ]);
    expect(stamped.headers.get(WARM_TARGETS_HEADER)).not.toBeNull();
    const { response } = takeWarmTargets(stamped);
    expect(response.headers.get(WARM_TARGETS_HEADER)).toBeNull();
  });

  it("leaves an ordinary response untouched (the overwhelmingly common path)", () => {
    const original = htmlResponse();
    const { response, urls } = takeWarmTargets(original);
    expect(response).toBe(original); // not reconstructed on every request
    expect(urls).toEqual([]);
  });

  it("stamps nothing for an empty list, so callers need no conditional", () => {
    const original = new Response(null, { status: 303 });
    expect(withWarmTargets(original, [])).toBe(original);
  });
});
