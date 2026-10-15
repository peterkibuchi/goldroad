// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCacheableReadRequest,
  purgeLocalReadCache,
  READ_CACHE_CONTROL,
  READ_CACHE_TTL_SECONDS,
  readCacheKey,
  readSurfaceUrlsForSubject,
  serveWithReadCache,
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

function htmlResponse(body: BodyInit = "<!doctype html><title>ok</title>") {
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

  it("caches the marketing pages, campaign links included", () => {
    for (const path of [
      "/",
      "/leaving-substack",
      "/open",
      "/privacy",
      "/terms",
      "/policies",
      "/?utm_source=bsky",
      "/open?ref=x",
    ]) {
      expect(isCacheableReadRequest(req(path)), path).toBe(true);
    }
    // ...and they share the bare page's entry.
    expect(readCacheKey(req("/?utm_source=bsky"))).toBe(
      "https://trygoldroad.com/",
    );
  });

  it("renders the goodbye notice fresh: `/` reads ?notice= on the server", () => {
    expect(isCacheableReadRequest(req("/?notice=goodbye"))).toBe(false);
  });

  it("never caches the app, api, or img paths", () => {
    for (const path of [
      "/write",
      "/dashboard",
      "/settings",
      "/home",
      "/report",
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

const BUILD = "build-a";

/** serveWithReadCache as one build of the app, with the background store
 * finished before it returns, as it is by the time a real second request
 * arrives. */
async function serve(
  request: Request,
  fetchFresh: () => Promise<Response> | Response,
  build = BUILD,
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const res = await serveWithReadCache(
    request,
    fetchFresh,
    (p) => pending.push(p),
    build,
  );
  await Promise.all(pending);
  return res;
}

describe("serveWithReadCache — HIT/MISS flow", () => {
  it("misses then hits, invoking the loader exactly once", async () => {
    const cache = mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());

    const miss = await serve(req("/@awarm.space"), fetchFresh);
    expect(miss.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(miss.headers.get("cache-control")).toBe(READ_CACHE_CONTROL);
    expect(await miss.text()).toContain("<title>ok</title>");

    const hit = await serve(req("/@awarm.space"), fetchFresh);
    expect(hit.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(await hit.text()).toContain("<title>ok</title>");

    expect(fetchFresh).toHaveBeenCalledTimes(1); // the hit never re-ran the loader
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("collapses `?x=random` onto the same key (no MISS pollution)", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serve(req("/@awarm.space"), fetchFresh);
    await serve(req("/@awarm.space?x=1"), fetchFresh);
    await serve(req("/@awarm.space?x=2"), fetchFresh);
    expect(fetchFresh).toHaveBeenCalledTimes(1); // all share the /@awarm.space key
  });

  it("varies the key on a valid pagination cursor", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serve(req("/@awarm.space"), fetchFresh);
    await serve(req("/@awarm.space?cursor=3lyk73wxnok2f"), fetchFresh);
    expect(fetchFresh).toHaveBeenCalledTimes(2); // distinct pages, distinct keys
  });

  it("serves from cache even when the request carries a cookie", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serve(req("/@awarm.space"), fetchFresh); // warm
    const withCookie = await serve(
      req("/@awarm.space", { headers: { cookie: "gr_session=x" } }),
      fetchFresh,
    );
    expect(withCookie.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("hands a streaming page over at once and stores it in the background", async () => {
    const cache = mockCache();
    // Like the real Cache API: the store reads the body to its end.
    cache.put.mockImplementation(async (url, res) => {
      cache.store.set(String(url), new Response(await res.text(), res));
    });
    const encode = (text: string) => new TextEncoder().encode(text);
    let finish = () => {};
    // The article first, the replies once the test says they've arrived.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode("<!doctype html><title>ok</title>"));
        finish = () => {
          controller.enqueue(encode("<p>replies</p>"));
          controller.close();
        };
      },
    });
    const pending: Promise<unknown>[] = [];
    const outcome = await Promise.race([
      serveWithReadCache(
        req("/@awarm.space"),
        () => htmlResponse(body),
        (p) => pending.push(p),
        BUILD,
      ),
      new Promise<"held">((resolve) => setTimeout(resolve, 1_000, "held")),
    ]);
    finish();
    expect(
      outcome,
      "the response is held until the whole page has been stored",
    ).not.toBe("held");
    if (outcome === "held") return;
    expect(outcome.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(await outcome.text()).toContain("<p>replies</p>");
    await Promise.all(pending);
    const stored = cache.store.get("https://trygoldroad.com/@awarm.space");
    expect(await stored?.text()).toContain("<p>replies</p>");
  });

  it("renders afresh a page stored before builds were recorded", async () => {
    const cache = mockCache();
    cache.store.set("https://trygoldroad.com/", htmlResponse());
    const fetchFresh = vi.fn(async () => htmlResponse());
    const res = await serve(req("/"), fetchFresh);
    expect(res.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("renders afresh a page a previous build stored", async () => {
    mockCache();
    const fetchFresh = vi.fn(async () => htmlResponse());
    await serve(req("/@awarm.space"), fetchFresh, "build-a");
    // That page names build-a's hashed scripts, which a deploy removed.
    const after = await serve(req("/@awarm.space"), fetchFresh, "build-b");
    expect(after.headers.get("x-goldroad-cache")).toBe("MISS");
    const again = await serve(req("/@awarm.space"), fetchFresh, "build-b");
    expect(again.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(fetchFresh).toHaveBeenCalledTimes(2);
  });

  it("never caches a 404 or an upstream flake", async () => {
    const cache = mockCache();
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const res = await serve(req("/@ghost.invalid"), notFound);
    expect(res.status).toBe(404);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("never caches a page that marked itself no-store", async () => {
    const cache = mockCache();
    const failed = vi.fn(async () => {
      const r = htmlResponse();
      r.headers.set("cache-control", "no-store");
      return r;
    });
    await serve(req("/@awarm.space"), failed);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("never caches a response that sets a cookie", async () => {
    const cache = mockCache();
    const withCookie = vi.fn(async () => {
      const r = htmlResponse();
      r.headers.set("set-cookie", "gr_session=x");
      return r;
    });
    await serve(req("/@awarm.space"), withCookie);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("falls through untouched when the Cache API is absent (node/tests)", async () => {
    // no mockCache(): caches.default is undefined
    const fetchFresh = vi.fn(async () => htmlResponse());
    const res = await serve(req("/@awarm.space"), fetchFresh);
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
    const miss = await serve(req("/@awarm.space/rss.xml"), fetchFresh);
    expect(miss.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(miss.headers.get("cache-control")).toBe(READ_CACHE_CONTROL);

    const hit = await serve(req("/@awarm.space/rss.xml"), fetchFresh);
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
    const res = await serve(req("/@awarm.space/rss.xml"), json);
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
    expect(READ_CACHE_CONTROL).toContain("max-age=0,");
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
    await serve(req("/@awarm.space"), fetchFresh); // warm it

    const purged = await purgeLocalReadCache([
      "https://trygoldroad.com/@awarm.space",
      "https://trygoldroad.com/@never.cached",
    ]);
    expect(purged).toBe(1); // the second key was never stored
    expect(cache.delete).toHaveBeenCalledTimes(2);

    const after = await serve(req("/@awarm.space"), fetchFresh);
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
