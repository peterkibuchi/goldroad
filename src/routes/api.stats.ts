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
  queryFloorDay,
  rangeWindow,
  type SectionStatus,
  type StatsEnvelope,
  sourcesSection,
  viewsSection,
} from "~/lib/stats-sections";
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
        const cache = (globalThis as { caches?: { default?: Cache } }).caches
          ?.default;
        const cacheStatus: Partial<Record<StatsSection, "HIT" | "MISS">> = {};

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
              const cached = (await hit.json().catch(() => null)) as T | null;
              if (cached) {
                cacheStatus[name] = "HIT";
                return cached;
              }
            }
          }
          cacheStatus[name] = "MISS";
          let result: T | { status: SectionStatus };
          try {
            result = await compute();
          } catch (err) {
            console.warn("stats section failed", name, err);
            return { status: "unavailable" };
          }
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
              const ref = announcedPostUri(record.value.bskyPostRef);
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

/** JSON response that no shared HTTP cache may store — these payloads are
 * writer-private. (The Workers-cache copies above are stored under per-DID,
 * per-section, per-range keys with their own explicit max-age instead.) */
function privateJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
