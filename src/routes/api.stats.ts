import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import {
  isDid,
  listRecordPages,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
} from "~/lib/atproto";
import {
  announcedPostUri,
  fetchEngagementBatches,
  MAX_ENGAGEMENT_BATCHES,
  MAX_GET_POSTS_BATCH,
} from "~/lib/engagement";
import {
  selectSnapshotRange,
  snapshotSeries,
  utcDay,
} from "~/lib/follower-snapshots";
import { readLiveSessionDid } from "~/lib/live-session";
import { privateJson } from "~/lib/private-json";
import {
  buildDailyViewsQuery,
  buildReferrerQuery,
  buildStatsQuery,
  mapDayRows,
  mapDomainRows,
  mapPathRows,
  parseStatsRange,
  runHogQL,
  SECTION_TTL_SECONDS,
  type StatsRange,
  type StatsSection,
  statsCacheKey,
  writerPathRoots,
} from "~/lib/stats";
import {
  engagementSection,
  followersSection,
  isDegraded,
  queryFloorDay,
  rangeWindow,
  type SectionStatus,
  type StatsEnvelope,
  sourcesSection,
  viewsSection,
} from "~/lib/stats-sections";
import { defaultCache } from "~/lib/workers-cache";
import { env } from "cloudflare:workers";

/**
 * The writer's own analytics: GET /api/stats?range=7d|30d|90d|all.
 *
 * A SECTIONED envelope, not one payload with one status. Four independent
 * upstreams feed this surface — the PostHog Query API, our own D1, and the
 * public Bluesky AppView — and each section carries its own status, is computed
 * in its own settled promise, and is cached under its own key. Consequences that
 * matter: an instance with no analytics keys still serves real follower and
 * Bluesky numbers, a dead PostHog can't evict a healthy cached engagement
 * section, and there is no code path where one failing upstream produces a blank
 * page or a non-200. Only an unauthenticated request gets a non-200.
 *
 * Isolation: every filter is derived from the session DID server-side (see
 * ~/lib/stats). The only client input is `range`, validated against a frozen
 * allowlist and mapped through a frozen record before it can reach a query, and
 * separated into its own cache key so a seven-day payload can never answer a
 * thirty-day request. Announcement URIs come from the writer's own records,
 * never from the request.
 *
 * Every response carries `Cache-Control: private, no-store`: the payload is
 * writer-private even where the underlying Bluesky counts are public, because
 * the SET of posts is not.
 */
/**
 * The minimum a cached section must look like to be trusted: an object whose
 * `status` is one of the statuses this endpoint actually emits. Deliberately
 * shallow — it catches the realistic failure (a stale blob from a previous
 * deploy's shape) without re-validating every field on every cache hit, which
 * would cost more than recomputing.
 */
function isCachedSection(value: unknown): value is { status: SectionStatus } {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return (
    status === "ok" ||
    status === "unavailable" ||
    status === "not_configured" ||
    status === "insufficient_history" ||
    status === "empty"
  );
}

export const Route = createFileRoute("/api/stats")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did)) {
          return privateJson({ error: "unauthorized" }, 401);
        }

        const range = parseStatsRange(
          new URL(request.url).searchParams.get("range"),
        );
        const today = utcDay();
        const cache = defaultCache();
        const cacheStatus: Partial<Record<StatsSection, "HIT" | "MISS">> = {};

        /**
         * A section failed. One line, one shape, so it is greppable in Workers
         * logs (observability is on) and countable per section.
         *
         * A log rather than an event, deliberately: reporting from inside a
         * request would spend one of the 50 subrequests this handler shares
         * with the upstreams it is trying to measure, and a degraded section is
         * not an exception — routing it through error tracking would fill
         * $exception with things that never threw. When WEBHOOK_URL exists,
         * alerting belongs there, reading these lines.
         */
        const reportDegraded = (name: StatsSection, cause: unknown) => {
          const detail =
            cause instanceof Error
              ? cause.message
              : cause == null
                ? "upstream answered with a body we could not map"
                : String(cause);
          console.warn(
            `stats_section_degraded section=${name} range=${range} — ${detail}`,
          );
        };

        /**
         * Read-through cache for one section. Only healthy sections are stored,
         * so an upstream blip can't pin a failure for the whole TTL, and a
         * section that throws degrades to `unavailable` on its own — never
         * taking a sibling with it.
         */
        const section = async <T extends { status: SectionStatus }>(
          name: StatsSection,
          compute: () => Promise<T>,
        ): Promise<T | { status: SectionStatus }> => {
          const key = await statsCacheKey(did, name, range);
          if (cache) {
            const hit = await cache.match(key).catch(() => undefined);
            if (hit) {
              const cached: unknown = await hit.json().catch(() => null);
              // Validate rather than cast. A cached blob is the one input here
              // the compiler cannot check: `as T` type-checks whatever JSON is
              // at that key, so renaming a field on a section would keep
              // serving the OLD shape — typed as the new one — for up to an
              // hour, and a caller reading `views.total ?? 0` off a field that
              // no longer exists renders a zero. That is precisely the false
              // zero the rest of this file works to prevent, arriving through
              // the one door nothing was guarding.
              if (isCachedSection(cached)) {
                cacheStatus[name] = "HIT";
                return cached as T;
              }
              // A shape we don't recognise is treated as a miss, which is an
              // already-handled state — no new failure path.
            }
          }
          cacheStatus[name] = "MISS";
          let result: T | { status: SectionStatus };
          try {
            result = await compute();
          } catch (err) {
            reportDegraded(name, err);
            return { status: "unavailable" };
          }
          // The other way a section degrades, and the one that used to be
          // silent: a compute path that RETURNS `unavailable` rather than
          // throwing — an upstream that answered with a body we could not map.
          // Two of those exist below and neither said anything, so a section
          // could be dead for days while the page merely looked quiet.
          // Reporting here rather than at each return is the fix that keeps
          // working: this is the one place that sees every outcome, so a
          // section added later is covered without anyone remembering to.
          if (isDegraded(result.status)) reportDegraded(name, null);
          if (cache && result.status === "ok") {
            const stored = Response.json(result);
            stored.headers.set(
              "cache-control",
              `max-age=${SECTION_TTL_SECONDS[name]}`,
            );
            await cache.put(key, stored).catch(() => {});
          }
          return result;
        };

        const apiKey = env.POSTHOG_QUERY_API_KEY;
        const projectId = env.POSTHOG_PROJECT_ID;
        const configured = Boolean(apiKey && projectId);

        // Display resolution is best-effort: without a handle the DID root
        // still covers the writer's pages (readers can browse either form).
        const handle = configured
          ? await resolveDidToHandle(did).catch(() => null)
          : null;
        const roots = writerPathRoots(did, handle);
        const floor = queryFloorDay(range, today);

        // One shared day query serves both the views section and the traffic
        // sources' denominator, so the two can never disagree about the total.
        const daysPromise = configured
          ? runHogQL({
              apiKey: apiKey as string,
              projectId: projectId as string,
              query: buildDailyViewsQuery(roots, floor),
            }).then(mapDayRows)
          : Promise.resolve(null);

        const [views, sources, followers, engagement] = await Promise.all([
          section("views", async () => {
            if (!configured) return { status: "not_configured" as const };
            const [days, pathBody] = await Promise.all([
              daysPromise,
              runHogQL({
                apiKey: apiKey as string,
                projectId: projectId as string,
                query: buildStatsQuery(roots, rangeWindow(range, today).from),
              }),
            ]);
            const paths = mapPathRows(pathBody);
            if (days === null || paths === null)
              return { status: "unavailable" as const };
            return viewsSection({ days, paths, range, today });
          }),

          section("sources", async () => {
            if (!configured) return { status: "not_configured" as const };
            const window = rangeWindow(range, today);
            const [days, domainBody] = await Promise.all([
              daysPromise,
              runHogQL({
                apiKey: apiKey as string,
                projectId: projectId as string,
                query: buildReferrerQuery(roots, window.from),
              }),
            ]);
            const domains = mapDomainRows(domainBody);
            if (days === null || domains === null)
              return { status: "unavailable" as const };
            const total = days
              .filter(
                (row) =>
                  (window.from === null || row.day >= window.from) &&
                  row.day <= window.to,
              )
              .reduce((sum, row) => sum + row.views, 0);
            return sourcesSection({ domains, total });
          }),

          section("followers", async () => {
            const window = rangeWindow(range, today);
            const db = drizzle(env.DB);
            const from = window.from ?? "0000-01-01";
            const rows = await selectSnapshotRange(db, did, from, today);
            const series = snapshotSeries(rows, { from, to: today });
            return followersSection({ series });
          }),

          section("engagement", async () => {
            const window = rangeWindow(range, today);
            const pds = await resolveDidToPds(did);
            const { records } = await listRecordPages<StandardDocument>(
              pds,
              did,
              "site.standard.document",
              { maxPages: MAX_ENGAGEMENT_BATCHES },
            );

            const announced: Array<{
              rkey: string;
              uri: string;
              did: string;
              postRkey: string;
            }> = [];
            let unannouncedCount = 0;
            for (const record of records) {
              const rkey = record.uri.split("/").pop();
              if (!rkey) continue;
              const publishedAt =
                typeof record.value.publishedAt === "string"
                  ? record.value.publishedAt.slice(0, 10)
                  : null;
              // A post with no usable date stays in every range: it is the
              // writer's post, its thread is real, and hiding it would be a
              // stranger claim than counting it.
              if (
                publishedAt !== null &&
                window.from !== null &&
                publishedAt < window.from
              )
                continue;
              const ref = announcedPostUri(record.value.bskyPostRef, did);
              if (ref === null) {
                unannouncedCount++;
                continue;
              }
              announced.push({
                rkey,
                uri: ref.uri,
                did: ref.did,
                postRkey: ref.rkey,
              });
            }

            // Newest first, then capped to what the batch budget can answer for
            // — a writer's most recent conversation is the one they came to see.
            const inBudget = announced.slice(
              0,
              MAX_ENGAGEMENT_BATCHES * MAX_GET_POSTS_BATCH,
            );
            const { byUri, requested, answered } = await fetchEngagementBatches(
              {
                uris: inBudget.map((post) => post.uri),
              },
            );
            return engagementSection({
              announced: inBudget,
              byUri,
              requested,
              answered,
              unannouncedCount,
            });
          }),
        ]);

        const envelope: StatsEnvelope = {
          range: range satisfies StatsRange,
          generatedAt: new Date().toISOString(),
          views,
          sources,
          followers,
          engagement,
        };
        const res = privateJson(envelope);
        res.headers.set(
          "x-goldroad-cache",
          Object.entries(cacheStatus)
            .map(([name, state]) => `${name}=${state}`)
            .join(";"),
        );
        return res;
      },
    },
  },
});
