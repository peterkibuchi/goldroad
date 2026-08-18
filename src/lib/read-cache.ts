/**
 * Edge caching for the public reading surfaces — and, just as much, the fix for
 * a DoS lever. A hit on `/@handle`, `/@handle/$rkey`, or `/p/…` runs the full
 * handle→DID→PDS→listRecords/getRecord chain live (≈3–4 upstream fetches),
 * uncached — so a loop of requests burns the Worker request budget AND hammers
 * third-party PDSes from our IP. This wraps those GET responses in the Workers
 * Cache API (free tier — NOT R2, like `/img`), collapsing repeat reads to a
 * single edge lookup.
 *
 * TTL AND THE TAKEDOWN SLA. The takedown check runs INSIDE the loader, and a
 * HIT here returns the stored bytes without invoking the loader at all — so the
 * check is consulted on MISS only, never before the cache lookup. A longer TTL
 * therefore genuinely does widen the window in which an already-cached page
 * keeps being served after a `hidden_content` row lands. That is why the TTL
 * used to be 60 s, and why raising it to 300 s is only defensible together with
 * `readSurfaceUrlsForSubject` + `purgeLocalReadCache` below and the
 * `/api/cache-purge` hook that calls them: an urgent (legal/CSAM) takedown
 * purges the affected URLs in the same breath as the row, and the SLA is the
 * purge's latency rather than the TTL. 300 s (not 900) because it is the number
 * the two AppView sub-caches on these same pages already use
 * (ENGAGEMENT_CACHE_TTL_SECONDS, COMMENTS_CACHE_TTL_SECONDS) — one window to
 * reason about, not three — and because the marginal hit-rate gain past 5 min is
 * small next to the un-purged worst case it buys.
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
import { isDid, isHandle, isValidCursor, parseAtUri } from "~/lib/atproto";
import { defaultCache } from "~/lib/workers-cache";

/** Public shared-cache TTL for reading surfaces, in seconds. Raising this is
 * only safe alongside a working purge — see the takedown note in the module
 * doc above before touching it. */
export const READ_CACHE_TTL_SECONDS = 300;
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

/**
 * Every reading-surface URL that can be showing a given takedown subject — the
 * purge list for a `hidden_content` row, and the warm list after a publish.
 *
 * `subject` is exactly what the hide list stores: a bare DID (author-level) or
 * an `at://<did>/site.standard.document/<rkey>` URI (record-level). Anything
 * else yields an empty list rather than a guess.
 *
 * Three spellings of the same page have to be covered, because each is a
 * distinct cache key and a visitor can arrive on any of them:
 *
 * - **Both address forms.** These routes take a handle OR a raw DID in the same
 *   path position, so a document lives at `/@alice.example/<rkey>` AND at
 *   `/@did:plc:…/<rkey>`. The handle is passed in because resolving it needs a
 *   network call this pure function must not make.
 * - **Encoded and unencoded DIDs.** `encodeURIComponent` escapes the colons, so
 *   our own links mint `/@did%3Aplc%3A…` while a hand-typed or crawled URL
 *   arrives as `/@did:plc:…`. `URL` normalizes neither into the other.
 * - **With and without the index's trailing slash.** `/@h` and `/@h/` are two
 *   paths and `readCacheKey` preserves the difference.
 *
 * Each candidate is round-tripped through `URL` so the strings this returns are
 * byte-identical to what `readCacheKey` stores under — the two must never drift,
 * which is why they live in the same module.
 *
 * KNOWN GAP, deliberately not papered over: an author-level (DID) subject also
 * needs every one of that author's document pages, which cannot be enumerated
 * without listing their repo, and the archive's `?cursor=` pages, which cannot
 * be enumerated at all. Those age out within READ_CACHE_TTL_SECONDS. For an
 * author-level takedown that has to be immediate, the escalation is a zone-wide
 * purge — which is what `/api/cache-purge` asks Cloudflare for when the subject
 * is a bare DID (see that route).
 */
export function readSurfaceUrlsForSubject(
  origin: string,
  subject: string,
  handle?: string | null,
): string[] {
  const record = parseAtUri(subject);
  const did = record?.did ?? (isDid(subject) ? subject : null);
  if (!did) return [];
  // A record subject that is not one of our documents addresses no page here.
  if (record && record.collection !== "site.standard.document") return [];

  const idents = [did, encodeURIComponent(did)];
  if (handle && isHandle(handle)) idents.push(handle);

  const urls = new Set<string>();
  const add = (path: string) => {
    try {
      urls.add(new URL(origin + path).toString());
    } catch {
      // A malformed origin is the caller's bug, not a reason to throw here.
    }
  };
  for (const ident of idents) {
    // The archive index and the feed list the record, so both go whether the
    // takedown is author- or record-level.
    add(`/@${ident}`);
    add(`/@${ident}/`);
    add(`/@${ident}/rss.xml`);
    if (record) {
      add(`/@${ident}/${record.rkey}`);
      add(`/p/${ident}/${record.rkey}`);
    }
  }
  return [...urls];
}

/**
 * Evicts read-surface URLs from the Workers cache — the LOCAL half of a purge.
 *
 * Cloudflare is explicit that this is per-data-center: "the contents of the
 * cache do not replicate outside of the originating data center", and
 * "`cache.delete` only purges content of the cache in the data center that the
 * Worker was invoked". So this alone does NOT make a takedown global; it makes
 * it immediate in one colo. Global eviction needs the zone REST API, which
 * needs a token — see `/api/cache-purge`, which does both and reports on each
 * honestly rather than letting a local-only delete look like a purge.
 *
 * Returns how many keys were actually present, so a caller can report a real
 * number instead of asserting success.
 */
export async function purgeLocalReadCache(
  urls: readonly string[],
): Promise<number> {
  const cache = defaultCache();
  if (!cache) return 0;
  const deleted = await Promise.all(
    urls.map((url) => cache.delete(url).catch(() => false)),
  );
  return deleted.filter(Boolean).length;
}

/** Bound on one warm self-fetch. Generous — it is a full cold render, which is
 * the whole point — but never unbounded, because it runs on `waitUntil` where
 * nothing is watching it. */
const WARM_FETCH_TIMEOUT_MS = 15_000;

/**
 * The reading surfaces one document write changes: the author's archive index,
 * and the document's own page when the write names one.
 *
 * Lives here rather than in the publish handler because it now has two callers
 * that reach `warmReadSurfaces` by different roads — the request path, which
 * hands its URLs to the Worker entry through a response header, and the CRON,
 * which has no response to hang a header on and calls the warm directly. Two
 * spellings of "which pages did this publish change" would drift, and the one
 * that drifted would be the cron's: nobody is watching at 09:00.
 *
 * `ident` is spelled exactly as our own links mint it (announce URLs, the
 * canonical composed URL), because that is the key a shared link will actually
 * be cached under.
 *
 * The archive index goes on the list whenever a document does: publishing,
 * editing a title, or deleting all change the list it renders.
 */
export function readSurfaceWarmUrls(opts: {
  origin: string;
  ident: string;
  rkey?: string;
}): string[] {
  const base = `${opts.origin}/@${encodeURIComponent(opts.ident)}`;
  return [base, ...(opts.rkey ? [`${base}/${opts.rkey}`] : [])];
}

/**
 * Pre-renders read surfaces into THIS colo's cache: delete, then fetch.
 *
 * The delete is not optional. `serveWithReadCache` answers a warm key from the
 * cache, so a plain fetch of an already-cached URL is a HIT that re-stores
 * nothing — which is exactly the case that matters after a publish, where the
 * author's archive index is cached and now stale. Delete-then-fetch forces the
 * MISS that repopulates it.
 *
 * `origin` is an allowlist, not decoration: the URL list arrives via an
 * internal response header (see `takeWarmTargets`), and a bug that let anything
 * else into it must not turn this into a request amplifier pointed at a
 * stranger. Anything not on our own origin is dropped silently.
 *
 * Bodies are drained rather than cancelled — the point is to let the subrequest
 * run to completion so its `cache.put` lands. Every failure is swallowed: a
 * warm that doesn't happen costs one cold render, which is the status quo.
 */
export async function warmReadSurfaces(
  urls: readonly string[],
  opts: { origin: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const own = urls.filter((url) => {
    try {
      return new URL(url).origin === new URL(opts.origin).origin;
    } catch {
      return false;
    }
  });
  if (own.length === 0) return;

  const doFetch = opts.fetchImpl ?? fetch;
  await purgeLocalReadCache(own);
  await Promise.all(
    own.map(async (url) => {
      try {
        const res = await doFetch(url, {
          headers: { "x-goldroad-warm": "1" },
          signal: AbortSignal.timeout(WARM_FETCH_TIMEOUT_MS),
        });
        await res.arrayBuffer();
      } catch {
        // Best effort by design — see the doc comment.
      }
    }),
  );
}

/**
 * Internal response header carrying read-surface URLs to warm.
 *
 * The indirection exists because `ctx.waitUntil` is only reachable from the
 * Worker entry (src/server.ts) — a TanStack route handler never receives the
 * ExecutionContext — and background work started without it is cancelled the
 * moment the response is returned. So the publish handler, which knows WHICH
 * URLs just changed, stamps them here, and the entry, which holds the `ctx`,
 * takes them off and schedules the warm. It is stripped on the way out; the
 * test for that is the one that matters, because a leaked header would tell
 * every visitor which URLs we consider interesting.
 */
export const WARM_TARGETS_HEADER = "x-goldroad-warm-targets";

/** Stamps read-surface URLs onto a handler's response for the entry to pick up.
 * No-op for an empty list, so callers need no conditional. */
export function withWarmTargets(
  response: Response,
  urls: readonly string[],
): Response {
  if (urls.length === 0) return response;
  const res = new Response(response.body, response);
  res.headers.set(WARM_TARGETS_HEADER, urls.join(" "));
  return res;
}

/**
 * Reads and REMOVES the warm-target header. Returns the response to actually
 * send — the original object untouched when there was no header (reconstructing
 * every response to strip a header that is almost never there would be a cost
 * paid on every request for the benefit of a few).
 */
export function takeWarmTargets(response: Response): {
  response: Response;
  urls: string[];
} {
  const raw = response.headers.get(WARM_TARGETS_HEADER);
  if (!raw) return { response, urls: [] };
  const stripped = new Response(response.body, response);
  stripped.headers.delete(WARM_TARGETS_HEADER);
  return {
    response: stripped,
    urls: raw.split(" ").filter((url) => url !== ""),
  };
}
