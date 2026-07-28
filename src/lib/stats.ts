/**
 * Writer-stats provider for /api/stats: per-publication pageview aggregates
 * from the PostHog Query API (HogQL). Env-gated end to end:
 *
 * - POSTHOG_QUERY_API_KEY + POSTHOG_PROJECT_ID absent → the route answers
 *   `{ enabled: false }` and this module is never asked to fetch anything.
 * - Both present → one bounded HogQL query per (writer, 10 minutes),
 *   aggregating `$pageview` events on the writer's own publication paths.
 *
 * Isolation invariant (the one that matters): the path filter is DERIVED
 * SERVER-SIDE from the session DID — nothing the client sends participates
 * in the query, so a writer can never widen the filter onto someone else's
 * publication. Path roots are compared with equals/startsWith rather than
 * LIKE: DIDs may legally contain `%` (did:web percent-encoding), which under
 * LIKE would act as a wildcard and quietly widen the match.
 *
 * Pure module — no `cloudflare:workers` import, so tests can exercise it.
 */

import { readBodyCapped } from "~/lib/blob";

/** Workers-cache TTL for one writer's stats payload. */
export const STATS_CACHE_TTL_SECONDS = 600; // 10 minutes

/** The PostHog Query API must answer within this budget. */
const QUERY_TIMEOUT_MS = 10_000;

/** Hard cap on the upstream response body (the mapped result is ≤200 rows —
 * anything near this size is malformed or hostile). */
const MAX_RESPONSE_BYTES = 262_144; // 256 KB

/** At most this many per-path rows come back (a publication with more
 * distinct pageview paths than this still gets a correct top-N + total of N). */
const MAX_PATH_ROWS = 200;

export type WriterStats =
  | {
      enabled: true;
      total: number;
      paths: Array<{ path: string; views: number }>;
    }
  | { enabled: true; error: "unavailable" };

/** The full response shape GET /api/stats can serve, including the
 * feature-off arm — one type for client code to import instead of
 * re-deriving the union at the call site. */
export type StatsResponse = { enabled: false } | WriterStats;

/** The provider is configured but this request couldn't be served — mapped
 * from EVERY upstream failure mode without carrying upstream detail. */
const UNAVAILABLE: WriterStats = { enabled: true, error: "unavailable" };

/**
 * The path roots a writer's publication answers on. Reading surfaces accept
 * handle or DID (`/@handle`, `/@did`), so pageviews can be recorded under
 * either — both roots are queried. (Legacy `/p/…` v0 URLs are deliberately
 * not counted yet; add their roots here if that ever matters.)
 */
export function writerPathRoots(did: string, handle: string | null): string[] {
  const roots = handle ? [`/@${handle}`, `/@${did}`] : [`/@${did}`];
  return [...new Set(roots)];
}

/** HogQL string-literal escaping: backslash first, then single quote. The
 * inputs are already shape-validated (DID regex, handle grammar — neither
 * admits quotes), so this is defence in depth, not the primary guard. */
export function escapeHogQLString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/**
 * Builds the aggregate query for one writer's path roots: pageviews on the
 * publication page itself (`equals`) and everything beneath it
 * (`startsWith` with an explicit trailing slash, so `/@ab` never matches
 * `/@abc`'s traffic). Production events only — dev/preview carry a
 * different app_env stamp.
 */
export function buildStatsQuery(roots: string[]): string {
  const perRoot = roots.map((root) => {
    const lit = escapeHogQLString(root);
    return `equals(properties.$pathname, '${lit}') OR startsWith(properties.$pathname, '${lit}/')`;
  });
  return [
    "SELECT properties.$pathname AS path, count() AS views",
    "FROM events",
    "WHERE event = '$pageview'",
    "AND properties.app_env = 'production'",
    `AND (${perRoot.join(" OR ")})`,
    "GROUP BY path",
    "ORDER BY views DESC",
    `LIMIT ${MAX_PATH_ROWS}`,
  ].join(" ");
}

/**
 * Workers-cache key for one writer's stats. The Cache API is SHARED across
 * every request in the colo, so per-writer privacy rests entirely on key
 * separation: a synthetic internal URL (never a routable path) carrying the
 * SHA-256 of the DID. Distinct DIDs → distinct digests → one writer's cached
 * stats can never answer another's request.
 */
export async function statsCacheKey(did: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(did),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://goldroad-stats.internal/v1/${hex}`;
}

/** Maps the Query API response (`results: [[path, views], …]`) to the stable
 * public shape, dropping malformed rows. A body without a results array is
 * an upstream problem → unavailable. */
export function mapQueryResults(data: unknown): WriterStats {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return UNAVAILABLE;
  const paths: Array<{ path: string; views: number }> = [];
  let total = 0;
  for (const row of results) {
    if (!Array.isArray(row)) continue;
    const [path, views] = row as unknown[];
    if (typeof path !== "string") continue;
    if (typeof views !== "number" || !Number.isFinite(views) || views < 0)
      continue;
    paths.push({ path, views });
    total += views;
  }
  return { enabled: true, total, paths };
}

/**
 * Runs the writer's aggregate query against the PostHog Query API. Bounded:
 * request timeout, response-size cap, and every failure mode — non-2xx,
 * malformed body, network error, timeout — collapses to `unavailable`
 * without surfacing upstream detail to the caller (or the client).
 */
export async function fetchWriterStats(options: {
  apiKey: string;
  projectId: string;
  roots: string[];
  fetcher?: typeof fetch;
}): Promise<WriterStats> {
  const { apiKey, projectId, roots, fetcher = fetch } = options;
  const url = `https://us.posthog.com/api/projects/${encodeURIComponent(projectId)}/query/`;
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query: buildStatsQuery(roots) },
      }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — never the body, which could carry upstream detail.
      console.warn("stats query failed", res.status);
      return UNAVAILABLE;
    }
    const bytes = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    if (!bytes) return UNAVAILABLE;
    return mapQueryResults(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return UNAVAILABLE;
  }
}
