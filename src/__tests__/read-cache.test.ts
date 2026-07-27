// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCacheableReadRequest,
  READ_CACHE_CONTROL,
  readCacheKey,
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
});
