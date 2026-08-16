/**
 * Edge caching for the public reading surfaces — and, just as much, the fix for
 * a DoS lever. A hit on `/@handle`, `/@handle/$rkey`, or `/p/…` runs the full
 * handle→DID→PDS→listRecords/getRecord chain live (≈3–4 upstream fetches),
 * uncached — so a loop of requests burns the Worker request budget AND hammers
 * third-party PDSes from our IP. This wraps those GET responses in the Workers
 * Cache API (free tier — NOT R2, like `/img`), collapsing repeat reads to a
 * single edge lookup.
 *
 * TTL is deliberately SHORT (`s-maxage=60`, short SWR): reading surfaces render
 * third-party content that can be taken down, and a cached page is served
 * WITHOUT re-running the takedown check until it expires. 60 s bounds that
 * residual window. Because a takedown is just a `hidden_content` row that the
 * loader consults, an urgent (legal/CSAM) one must ALSO purge the cache for the
 * affected URLs — inserting the row alone leaves the page served until the
 * entry ages out.
 *
 * These surfaces are NEVER personalized (the reader loaders don't read the
 * session), so responses are cached and served regardless of any cookie. That
 * is load-bearing for the mitigation itself: keying anonymity to the cookie
 * would let an attacker send `Cookie: gr_session=x` to dodge the cache and
 * force full-cost renders. If a reading surface ever becomes personalized, add
 * a Vary/skip here.
 *
 * The cache key is normalized to origin + pathname, plus the validated `cursor`
 * param on the one path that paginates — every other query param is stripped,
 * so `/@h?x=<random>` can't mint distinct full-cost MISSes. This NARROWS but
 * does not fully close the amplifier: `isValidCursor` checks shape only, so
 * `/@h?cursor=<random-valid-shape>` still varies the key on that path and
 * forces a MISS. Volumetric abuse of that is the job of a CDN rate-limit rule
 * on read paths, configured outside this codebase — the cache handles the
 * common repeated-read case. Only 200
 * responses of an allowlisted content type (the HTML pages plus the RSS
 * feeds — see CACHEABLE_CONTENT_TYPES) without a Set-Cookie are stored; 404s
 * (takedowns included) and upstream flakes never cache, so they re-run the
 * check next hit.
 */
import { isValidCursor } from "~/lib/atproto";
import { defaultCache } from "~/lib/workers-cache";

/** Public shared-cache TTL for reading surfaces, in seconds. */
export const READ_CACHE_TTL_SECONDS = 60;
const STALE_WHILE_REVALIDATE_SECONDS = 60;
export const READ_CACHE_CONTROL = `public, s-maxage=${READ_CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`;

/** Paths whose GET responses are safe to serve to any visitor:
 * `/@…` (publication page, composed document, and the publication RSS feed
 * at `/@…/rss.xml`) and `/p/…` (v0 document URL). */
const READ_SURFACE_RE = /^\/(@|p\/)/;

/** Whether this request is a GET to a cacheable reading surface. */
export function isCacheableReadRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  return READ_SURFACE_RE.test(new URL(request.url).pathname);
}

/** The only paths that paginate: a bare `/@handle`, whose "Older posts" link
 * carries `?cursor=`. A document page and an RSS feed both ignore the param, so
 * varying their keys on it would mint unlimited distinct full-cost MISSes for
 * byte-identical content — and `isValidCursor` is shape-only, so any 512-char
 * string qualifies. Keep the vary where pagination actually lives. */
const PAGINATED_PATH_RE = /^\/@[^/]+\/?$/;

/** Normalized cache key: origin + pathname, plus a valid `cursor` param on the
 * one path that reads it. Stripping the rest prevents cache-key pollution. */
export function readCacheKey(request: Request): string {
  const url = new URL(request.url);
  const key = new URL(url.origin + url.pathname);
  const cursor = url.searchParams.get("cursor");
  if (cursor && isValidCursor(cursor) && PAGINATED_PATH_RE.test(url.pathname)) {
    key.searchParams.set("cursor", cursor);
  }
  return key.toString();
}

/** Content types a read surface legitimately serves: the HTML pages and the
 * per-publication RSS feeds that live under the same `/@…` namespace. An
 * allowlist, deliberately — anything a future route serves under a read path
 * stays uncached until it is listed here, so the 200/no-Set-Cookie/known-type
 * guard never silently widens. */
const CACHEABLE_CONTENT_TYPES = ["text/html", "application/rss+xml"];

function isCacheableResponse(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return (
    response.status === 200 &&
    CACHEABLE_CONTENT_TYPES.some((allowed) => type.includes(allowed)) &&
    !response.headers.has("set-cookie")
  );
}

/**
 * Serves a reading-surface GET through the Workers Cache API. On a hit the
 * stored HTML is returned without invoking the loader (zero upstream fetches,
 * zero D1 reads) tagged `x-goldroad-cache: HIT`; on a miss the fresh response
 * is stamped with `Cache-Control`, stored, and returned tagged `MISS`.
 * Non-cacheable requests/responses fall straight through to `fetchFresh`.
 */
export async function serveWithReadCache(
  request: Request,
  fetchFresh: () => Promise<Response> | Response,
): Promise<Response> {
  const cache = defaultCache();
  if (!cache || !isCacheableReadRequest(request)) {
    return fetchFresh();
  }

  const key = readCacheKey(request);
  const hit = await cache.match(key);
  if (hit) return hit; // stored copy already carries x-goldroad-cache: HIT

  const fresh = await fetchFresh();
  if (!isCacheableResponse(fresh)) return fresh;

  // Reconstruct so headers are mutable (a handler response may be immutable),
  // then tee: one copy is stored tagged HIT (that is what a future hit serves),
  // the returned copy is tagged MISS.
  const stored = new Response(fresh.body, fresh);
  stored.headers.set("cache-control", READ_CACHE_CONTROL);
  const served = stored.clone();
  stored.headers.set("x-goldroad-cache", "HIT");
  await cache.put(key, stored).catch(() => {});
  served.headers.set("x-goldroad-cache", "MISS");
  return served;
}
