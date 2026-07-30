/**
 * Cross-network engagement for the reading surfaces: per-post like/reply/
 * repost/quote counts pulled from the PUBLIC Bluesky AppView
 * (app.bsky.feed.getPosts), keyed off the announce write-back
 * (StandardDocument.bskyPostRef). Unauthenticated, no PDS involved — this is
 * the one thing a reading surface talks to public.api.bsky.app for directly
 * rather than the writer's own repo.
 *
 * Scope: counts exist ONLY for
 * announced posts. An unannounced post gets silence on the public page, never
 * a zero — "null ≠ zero" is already this codebase's discipline (dashboard
 * load failures, ~/lib/stats's absent-path rows). Every failure mode here
 * degrades the same way: return nothing, never block the page render.
 *
 * Pure module — no `cloudflare:workers` import — so tests exercise it
 * directly; the Workers Cache lookup is feature-detected exactly like
 * ~/lib/read-cache and the /img route, not threaded through env.
 */
import { type Did, parseAtUri } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";

/** The AppView host this module is allowed to talk to — FIXED, never derived
 * from a DID document or any other untrusted input (unlike resolveDidToPds,
 * which legitimately follows an attacker-influenced hostname). SSRF guard by
 * construction: no code path here builds this URL from a variable host. */
const APPVIEW_HOST = "public.api.bsky.app";

/** app.bsky.feed.getPosts accepts at most this many URIs per call. */
export const MAX_GET_POSTS_BATCH = 25;

const FETCH_TIMEOUT_MS = 5_000;

/** Hard cap on the upstream response body — a batch of 25 posts' worth of
 * JSON runs a few KB; anything near this size is malformed or hostile. */
const MAX_RESPONSE_BYTES = 262_144; // 256 KB

/** Every count is OPTIONAL in the AppView response — "uncounted", not zero.
 * Rendered UI must skip a metric entirely when it's undefined here, never
 * show a false "0". */
export type EngagementCounts = {
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
};

/** Edge-cache TTL for one post's engagement counts. Longer than the reading
 * surfaces' own 60s page cache (~/lib/read-cache): this decouples the
 * AppView call's own cost/rate limit from how often the page itself gets a
 * fresh render — the same reasoning ~/lib/stats uses its own longer TTL for. */
export const ENGAGEMENT_CACHE_TTL_SECONDS = 300;

/** bsky.app profile/post URL — DIDs and handles go in RAW: bsky.app's router
 * rejects percent-encoded colons (`did%3Aplc%3A…` → "Invalid DID or handle"),
 * and both shapes are already URL-path-safe (validated upstream as isDid /
 * isHandle; TID rkeys are base32). Shared with the writer dashboard's
 * "Announced ↗" / "View on Bluesky" links so the two surfaces never drift. */
export function bskyPostUrl(actor: string, rkey: string): string {
  return `https://bsky.app/profile/${actor}/post/${rkey}`;
}

/** bsky.app profile URL — same raw-actor rule as bskyPostUrl. */
export function bskyProfileUrl(actor: string): string {
  return `https://bsky.app/profile/${actor}`;
}

/** A document's bskyPostRef, validated down to the canonical at:// URI
 * app.bsky.feed.getPosts expects — or null (never announced, or the ref is
 * malformed/points somewhere else). Rebuilds the URI from parseAtUri's
 * validated parts rather than trusting the ref's raw string verbatim. */
export function announcedPostUri(
  ref: { uri?: unknown } | undefined,
): { uri: string; did: Did; rkey: string } | null {
  if (typeof ref?.uri !== "string") return null;
  const parts = parseAtUri(ref.uri);
  if (parts?.collection !== "app.bsky.feed.post") return null;
  return {
    uri: `at://${parts.did}/${parts.collection}/${parts.rkey}`,
    did: parts.did,
    rkey: parts.rkey,
  };
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Split URIs into calls the lexicon will accept. */
export function chunkUris(
  uris: readonly string[],
  size: number = MAX_GET_POSTS_BATCH,
): string[][] {
  const step = Math.max(1, Math.min(size, MAX_GET_POSTS_BATCH));
  const chunks: string[][] = [];
  for (let i = 0; i < uris.length; i += step)
    chunks.push(uris.slice(i, i + step));
  return chunks;
}

/**
 * One getPosts response, joined to the URIs it was asked about — BY URI, never
 * by index.
 *
 * This is the single most dangerous join in the codebase. getPosts returns
 * fewer posts than requested, in any order, whenever a post has been deleted,
 * blocked, or taken down; an index-based join would then silently attribute one
 * post's likes to a different post and there would be nothing in the UI to
 * suggest it. So the mapper takes the requested list, keys everything by URI,
 * and marks the URIs that didn't come back as `"gone"` — an explicit fact the
 * surface can state rather than a hole it has to guess at. URIs in the response
 * that nobody asked about are ignored.
 */
export function mapGetPostsResponse(
  data: unknown,
  requested: readonly string[],
): Map<string, EngagementCounts | "gone"> {
  const wanted = new Set(requested);
  const byUri = new Map<string, EngagementCounts | "gone">();
  const posts = (data as { posts?: unknown } | null)?.posts;
  if (Array.isArray(posts)) {
    for (const post of posts) {
      const p = post as Record<string, unknown> | null;
      if (typeof p?.uri !== "string" || !wanted.has(p.uri)) continue;
      byUri.set(p.uri, {
        likeCount: numOrUndefined(p.likeCount),
        replyCount: numOrUndefined(p.replyCount),
        repostCount: numOrUndefined(p.repostCount),
        quoteCount: numOrUndefined(p.quoteCount),
      });
    }
  }
  for (const uri of wanted) if (!byUri.has(uri)) byUri.set(uri, "gone");
  return byUri;
}

/** One getPosts call. Returns the parsed body, or null when the call failed in
 * any way at all (non-2xx, network error, timeout, oversized or unparseable
 * body) — a failed batch is a fact the caller reports, not an exception. */
async function fetchPostsBatch(
  batch: readonly string[],
  fetcher: typeof fetch,
): Promise<unknown | null> {
  const params = new URLSearchParams();
  for (const uri of batch) params.append("uris", uri);
  const url = `https://${APPVIEW_HOST}/xrpc/app.bsky.feed.getPosts?${params}`;
  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const bytes = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Batched app.bsky.feed.getPosts — chunks into groups of
 * MAX_GET_POSTS_BATCH, public + unauthenticated. Every failure mode
 * (non-2xx, network error, timeout, oversized/malformed body) drops just
 * that chunk's URIs from the result map rather than throwing — a partial
 * answer beats none, and the caller never blocks on this.
 */
export async function fetchPostsEngagement(
  uris: string[],
  fetcher: typeof fetch = fetch,
): Promise<Map<string, EngagementCounts>> {
  const result = new Map<string, EngagementCounts>();
  const validUris = uris.filter((u) => u.startsWith("at://"));
  for (const batch of chunkUris(validUris)) {
    const body = await fetchPostsBatch(batch, fetcher);
    if (body === null) continue;
    for (const [uri, counts] of mapGetPostsResponse(body, batch)) {
      // The reading surfaces only care about posts that answered; a missing
      // post gets silence there, exactly as an unannounced one does.
      if (counts !== "gone") result.set(uri, counts);
    }
  }
  return result;
}

/** How many batches one analytics read is allowed — the 100 most recent
 * announced posts. A bound on politeness as much as on latency: this is a
 * public good with no published rate limit, so we cache our own reads instead
 * of leaning on their tolerance. */
export const MAX_ENGAGEMENT_BATCHES = 4;

/** Parallel getPosts calls. Two, not four: bounded wall-clock time without
 * turning a public API into a thundering herd. */
const BATCH_CONCURRENCY = 2;

export type BatchedEngagement = {
  byUri: Map<string, EngagementCounts | "gone">;
  /** URIs we asked about, after chunk capping. */
  requested: number;
  /** URIs that came back from a batch that answered — the denominator the
   * surface reports its aggregate over. */
  answered: number;
};

/**
 * The analytics-facing read: every announced post's counts in as few calls as
 * the lexicon allows, with partial failure reported rather than hidden.
 *
 * `answered` counts only URIs from batches that came back, so a surface can say
 * "counted across 18 of your 25 shared posts" instead of presenting a partial
 * sum as a total. A batch that fails leaves its URIs absent from the map, which
 * is distinct from present-but-`"gone"`: one means we couldn't look, the other
 * means we looked and the post isn't there.
 */
export async function fetchEngagementBatches(opts: {
  uris: readonly string[];
  fetcher?: typeof fetch;
  maxBatches?: number;
}): Promise<BatchedEngagement> {
  const { uris, fetcher = fetch, maxBatches = MAX_ENGAGEMENT_BATCHES } = opts;
  const valid = uris.filter((u) => u.startsWith("at://"));
  const batches = chunkUris(valid).slice(0, Math.max(0, maxBatches));
  const byUri = new Map<string, EngagementCounts | "gone">();
  const requested = batches.reduce((n, batch) => n + batch.length, 0);
  let answered = 0;

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= batches.length) return;
      const batch = batches[index];
      const body = await fetchPostsBatch(batch, fetcher);
      if (body === null) continue; // this batch's URIs stay absent
      answered += batch.length;
      for (const [uri, counts] of mapGetPostsResponse(body, batch))
        byUri.set(uri, counts);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, worker),
  );

  return { byUri, requested, answered };
}

/** Feature-detected Workers Cache API access — absent under plain vitest/
 * node, same pattern as ~/lib/read-cache / the /img route. */
function defaultCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/** Synthetic, cacheable-key URL for one post's engagement — public data
 * (unlike ~/lib/stats's per-writer key), so the raw URI is fine to carry
 * directly; still a synthetic internal host, never a routable path. */
function engagementCacheUrl(uri: string): string {
  return `https://goldroad-engagement.internal/v1/${encodeURIComponent(uri)}`;
}

export type DocumentEngagement = {
  counts: EngagementCounts;
  /** bsky.app thread — the reply count's link target, because the reply
   * conversation lives on the network, not here. */
  threadUrl: string;
};

/**
 * True when at least one metric is actually counted. An announced post whose
 * AppView entry carries no counted field (every one `undefined`) renders
 * nothing at all, exactly like a post that was never announced — a rendered
 * "0" would be a claim the data doesn't support.
 */
export function hasCountedEngagement(counts: EngagementCounts): boolean {
  return (
    counts.likeCount !== undefined ||
    counts.replyCount !== undefined ||
    counts.repostCount !== undefined ||
    counts.quoteCount !== undefined
  );
}

/** Cache read for one post's counts — a miss, a malformed entry, and a cache
 * that isn't available at all are all the same answer: null. */
async function readCachedCounts(
  cache: Cache,
  uri: string,
): Promise<EngagementCounts | null> {
  const hit = await cache.match(engagementCacheUrl(uri)).catch(() => undefined);
  if (!hit) return null;
  const cached = (await hit.json().catch(() => null)) as {
    counts?: EngagementCounts;
  } | null;
  return cached?.counts ?? null;
}

/** Cache write for one post's counts. Best-effort — a failed put costs the
 * next reader an upstream call and nothing else. */
async function writeCachedCounts(
  cache: Cache,
  uri: string,
  counts: EngagementCounts,
): Promise<void> {
  const response = new Response(JSON.stringify({ counts }), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, s-maxage=${ENGAGEMENT_CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(engagementCacheUrl(uri), response).catch(() => {});
}

/**
 * The document-page-facing entry point: given a document's raw bskyPostRef,
 * returns its engagement counts + the bsky.app thread URL, or null when the
 * post was never announced, the ref is malformed, or every upstream attempt
 * failed — the caller renders nothing in all three cases (honest silence,
 * never a zero). Cached at the edge for ENGAGEMENT_CACHE_TTL_SECONDS so a
 * burst of reads on one popular post makes at most one upstream AppView call
 * per cache window.
 */
export async function getDocumentEngagement(
  ref: { uri?: unknown } | undefined,
  options: { fetcher?: typeof fetch; cache?: Cache } = {},
): Promise<DocumentEngagement | null> {
  const announced = announcedPostUri(ref);
  if (!announced) return null;
  const threadUrl = bskyPostUrl(announced.did, announced.rkey);

  const cache = options.cache ?? defaultCache();
  if (cache) {
    const cached = await readCachedCounts(cache, announced.uri);
    if (cached) return { counts: cached, threadUrl };
  }

  const fetcher = options.fetcher ?? fetch;
  const byUri = await fetchPostsEngagement([announced.uri], fetcher);
  const counts = byUri.get(announced.uri);
  if (!counts) return null;

  if (cache) await writeCachedCounts(cache, announced.uri, counts);

  return { counts, threadUrl };
}

/**
 * List-facing entry point — one call for a whole page of posts, keyed by
 * whatever id the caller already uses for a row (an rkey, typically).
 *
 * Shares the per-post edge cache with getDocumentEngagement above, so a
 * writer's list view and their readers' document pages warm the same
 * entries. Only the cache misses reach the AppView, in batches of
 * MAX_GET_POSTS_BATCH.
 *
 * A key is ABSENT from the returned map whenever there's nothing honest to
 * say about it: never announced, malformed ref, or every upstream attempt for
 * its batch failed. Callers render nothing for absent keys.
 */
export async function getPostsEngagement(
  refs: ReadonlyArray<{ key: string; ref: { uri?: unknown } | undefined }>,
  options: { fetcher?: typeof fetch; cache?: Cache } = {},
): Promise<Map<string, DocumentEngagement>> {
  const result = new Map<string, DocumentEngagement>();
  // De-duplicate by URI: two rows pointing at the same announcement (a
  // re-announce that reused the ref) must not become two upstream lookups.
  const wanted = new Map<string, { key: string; did: Did; rkey: string }[]>();
  for (const { key, ref } of refs) {
    const announced = announcedPostUri(ref);
    if (!announced) continue;
    const bucket = wanted.get(announced.uri);
    const entry = { key, did: announced.did, rkey: announced.rkey };
    if (bucket) bucket.push(entry);
    else wanted.set(announced.uri, [entry]);
  }
  if (wanted.size === 0) return result;

  function record(uri: string, counts: EngagementCounts) {
    for (const { key, did, rkey } of wanted.get(uri) ?? []) {
      result.set(key, { counts, threadUrl: bskyPostUrl(did, rkey) });
    }
  }

  const cache = options.cache ?? defaultCache();
  const uris = [...wanted.keys()];
  const misses: string[] = [];
  if (cache) {
    const cached = await Promise.all(
      uris.map(
        async (uri) => [uri, await readCachedCounts(cache, uri)] as const,
      ),
    );
    for (const [uri, counts] of cached) {
      if (counts) record(uri, counts);
      else misses.push(uri);
    }
  } else {
    misses.push(...uris);
  }
  if (misses.length === 0) return result;

  const fetched = await fetchPostsEngagement(misses, options.fetcher ?? fetch);
  for (const [uri, counts] of fetched) {
    // Guard against an upstream echoing a URI we never asked for.
    if (!wanted.has(uri)) continue;
    record(uri, counts);
    if (cache) await writeCachedCounts(cache, uri, counts);
  }
  return result;
}
