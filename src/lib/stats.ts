/**
 * Reader-stats provider for /api/stats: the PostHog Query API (HogQL) side of
 * the writer's analytics — per-day totals, per-path totals, and referring
 * domains, each bounded and each mapped through a tolerant reader.
 *
 * Env-gated end to end: without POSTHOG_QUERY_API_KEY + POSTHOG_PROJECT_ID the
 * route reports the reader-count sections as `not_configured` and this module
 * is never asked to fetch anything. (The follower and Bluesky-engagement
 * sections don't touch PostHog, so /stats is a real destination either way.)
 *
 * Isolation invariant (the one that matters): the path filter is DERIVED
 * SERVER-SIDE from the session DID — nothing the client sends participates in
 * the query, so a writer can never widen the filter onto someone else's
 * publication. The one client-supplied value, `range`, is validated against a
 * frozen allowlist and mapped to an integer from a frozen record before it can
 * influence a query at all. Path roots are compared with equals/startsWith
 * rather than LIKE: DIDs may legally contain `%` (did:web percent-encoding),
 * which under LIKE would act as a wildcard and quietly widen the match.
 *
 * Pure module — no `cloudflare:workers` import, so tests can exercise it.
 */

import { readBodyCapped } from "~/lib/blob";
import { isDay } from "~/lib/follower-snapshots";

/** The PostHog Query API must answer within this budget. */
const QUERY_TIMEOUT_MS = 10_000;

/** Hard cap on the upstream response body. The largest mapped result is ≤800
 * day rows — anything near this size is malformed or hostile. */
const MAX_RESPONSE_BYTES = 262_144; // 256 KB

/** At most this many per-path rows come back (a publication with more distinct
 * pageview paths than this still gets a correct top-N). */
const MAX_PATH_ROWS = 200;

/** Day rows. Covers the widest window we ask for (two years of daily rows)
 * with room to spare, so the cap never silently truncates a series. */
const MAX_DAY_ROWS = 800;

/** Referring-domain rows. The tail past this cut is reconciled into "Other
 * sites" by ~/lib/referrers rather than dropped. */
const MAX_REFERRER_ROWS = 100;

/** Selectable windows, and the day count each means. Frozen: this record is
 * the ONLY path from the client's `range` string to a number that reaches a
 * query, which is what makes the client's input non-participating. */
export const RANGE_DAYS = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
} as const);

export type StatsRange = keyof typeof RANGE_DAYS;

const RANGE_VALUES = Object.keys(RANGE_DAYS) as StatsRange[];

export const DEFAULT_RANGE: StatsRange = "30d";

/** A range from untrusted input. Anything unrecognized silently becomes the
 * default — a stray query string must never 400 a writer's own analytics. */
export function parseStatsRange(value: unknown): StatsRange {
  return typeof value === "string" && (RANGE_VALUES as string[]).includes(value)
    ? (value as StatsRange)
    : DEFAULT_RANGE;
}

/** Days in a range, or null for "as far back as we can see". */
export function rangeDays(range: StatsRange): number | null {
  return RANGE_DAYS[range];
}

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
 * inputs are already shape-validated (DID regex, handle grammar, day regex —
 * none admits quotes), so this is defence in depth, not the primary guard. */
export function escapeHogQLString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/** Pageviews on the publication page itself (`equals`) and everything beneath
 * it (`startsWith` with an explicit trailing slash, so `/@ab` never matches
 * `/@abc`'s traffic). */
function pathPredicate(roots: string[]): string {
  return roots
    .map((root) => {
      const lit = escapeHogQLString(root);
      return `equals(properties.$pathname, '${lit}') OR startsWith(properties.$pathname, '${lit}/')`;
    })
    .join(" OR ");
}

/**
 * The shared WHERE clauses: production events only (dev/preview carry a
 * different app_env stamp), this writer's paths only, and — when a window is
 * asked for — a UTC day floor. `sinceDay` is re-validated here even though it
 * is minted from our own clock: a day string is about to be interpolated into a
 * query, so it gets checked at the point of interpolation, not just at birth.
 */
function whereClauses(roots: string[], sinceDay: string | null): string[] {
  const clauses = [
    "WHERE event = '$pageview'",
    "AND properties.app_env = 'production'",
    `AND (${pathPredicate(roots)})`,
  ];
  if (sinceDay !== null) {
    if (!isDay(sinceDay)) throw new Error("invalid day floor");
    clauses.push(
      `AND timestamp >= toDateTime('${escapeHogQLString(sinceDay)} 00:00:00', 'UTC')`,
    );
  }
  return clauses;
}

/** Per-path totals — feeds the per-post table and the "most read" card. */
export function buildStatsQuery(
  roots: string[],
  sinceDay: string | null = null,
): string {
  return [
    "SELECT properties.$pathname AS path, count() AS views",
    "FROM events",
    ...whereClauses(roots, sinceDay),
    "GROUP BY path",
    "ORDER BY views DESC",
    `LIMIT ${MAX_PATH_ROWS}`,
  ].join(" ");
}

/**
 * Per-day totals in UTC. Days are bucketed in UTC here and follower snapshots
 * are stored in UTC, so the two series a writer can toggle between agree about
 * what a day is — the alternative (shifting one and not the other) is a chart
 * that lies at every boundary.
 */
export function buildDailyViewsQuery(
  roots: string[],
  sinceDay: string | null = null,
): string {
  return [
    "SELECT toString(toDate(timestamp, 'UTC')) AS day, count() AS views",
    "FROM events",
    ...whereClauses(roots, sinceDay),
    "GROUP BY day",
    "ORDER BY day",
    `LIMIT ${MAX_DAY_ROWS}`,
  ].join(" ");
}

/** Referring domains, most traffic first. The tail past the limit is
 * reconciled against the authoritative total (see ~/lib/referrers). */
export function buildReferrerQuery(
  roots: string[],
  sinceDay: string | null = null,
): string {
  return [
    "SELECT properties.$referring_domain AS domain, count() AS views",
    "FROM events",
    ...whereClauses(roots, sinceDay),
    "GROUP BY domain",
    "ORDER BY views DESC",
    `LIMIT ${MAX_REFERRER_ROWS}`,
  ].join(" ");
}

/** The `results: [[col, col], …]` matrix, or null when the body isn't one. */
function resultRows(data: unknown): unknown[][] | null {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  return results.filter((row): row is unknown[] => Array.isArray(row));
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export type PathRow = { path: string; views: number };
export type DayRow = { day: string; views: number };

/** Per-path rows, malformed rows dropped. Null means the body wasn't a
 * result set at all — an upstream problem, not an empty writer. */
export function mapPathRows(data: unknown): PathRow[] | null {
  const rows = resultRows(data);
  if (rows === null) return null;
  const out: PathRow[] = [];
  for (const [path, views] of rows) {
    const count = asCount(views);
    if (typeof path !== "string" || count === null) continue;
    out.push({ path, views: count });
  }
  return out;
}

/**
 * Per-day rows, oldest first. The day column is accepted as either a bare
 * `YYYY-MM-DD` or a full datetime string and truncated to the day — HogQL's
 * date rendering is an upstream detail, and a series that silently empties
 * because of a formatting change would be a very quiet bug.
 */
export function mapDayRows(data: unknown): DayRow[] | null {
  const rows = resultRows(data);
  if (rows === null) return null;
  const out: DayRow[] = [];
  for (const [day, views] of rows) {
    const count = asCount(views);
    if (typeof day !== "string" || count === null) continue;
    const normalized = day.slice(0, 10);
    if (!isDay(normalized)) continue;
    out.push({ day: normalized, views: count });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export type DomainRow = { domain: string | null; views: number };

/** Referring-domain rows. A null/absent domain is kept as null — it is the
 * "no referrer was passed on" case, which is a real bucket, not a bad row. */
export function mapDomainRows(data: unknown): DomainRow[] | null {
  const rows = resultRows(data);
  if (rows === null) return null;
  const out: DomainRow[] = [];
  for (const [domain, views] of rows) {
    const count = asCount(views);
    if (count === null) continue;
    out.push({
      domain: typeof domain === "string" ? domain : null,
      views: count,
    });
  }
  return out;
}

/** The cacheable sections of the envelope. */
export type StatsSection = "views" | "sources" | "followers" | "engagement";

/** Per-section Workers-cache lifetimes. Followers change once a day, so a
 * long TTL there costs nothing; reader counts and Bluesky counts move
 * continuously and get short ones. */
export const SECTION_TTL_SECONDS: Readonly<Record<StatsSection, number>> =
  Object.freeze({
    views: 600,
    sources: 600,
    engagement: 900,
    followers: 3600,
  });

/**
 * Workers-cache key for ONE SECTION of one writer's stats at one range.
 *
 * The Cache API is SHARED across every request in the colo, so per-writer
 * privacy rests entirely on key separation: a synthetic internal URL (never a
 * routable path) carrying the SHA-256 of the DID, plus the section and range as
 * distinct path segments. Distinct DIDs → distinct digests, and a 7-day payload
 * can never answer a 30-day request.
 */
export async function statsCacheKey(
  did: string,
  section: StatsSection,
  range: StatsRange,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(did),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://goldroad-stats.internal/v2/${hex}/${section}/${range}`;
}

/**
 * Runs one HogQL query. Bounded: request timeout, response-size cap, and every
 * failure mode — non-2xx, malformed body, network error, timeout — returns null
 * without surfacing upstream detail to the caller (or the client).
 */
export async function runHogQL(options: {
  apiKey: string;
  projectId: string;
  query: string;
  fetcher?: typeof fetch;
}): Promise<unknown | null> {
  const { apiKey, projectId, query, fetcher = fetch } = options;
  const url = `https://us.posthog.com/api/projects/${encodeURIComponent(projectId)}/query/`;
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — never the body, which could carry upstream detail.
      console.warn("stats query failed", res.status);
      return null;
    }
    const bytes = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
