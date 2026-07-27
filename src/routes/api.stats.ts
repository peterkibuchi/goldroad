import { createFileRoute } from "@tanstack/react-router";

import { isDid, resolveDidToHandle } from "~/lib/atproto";
import { readSessionDid } from "~/lib/session";
import {
  fetchWriterStats,
  STATS_CACHE_TTL_SECONDS,
  statsCacheKey,
  type WriterStats,
  writerPathRoots,
} from "~/lib/stats";
import { env } from "cloudflare:workers";

/**
 * Writer stats seam: GET /api/stats returns the signed-in writer's OWN
 * publication pageview aggregates (total + per-path), provided by the
 * PostHog Query API. Stable response shapes:
 *
 * - provider not configured → `{ enabled: false }` (the feature-off signal
 *   a future dashboard UI keys on)
 * - configured, upstream healthy → `{ enabled: true, total, paths: […] }`
 * - configured, upstream failed → `{ enabled: true, error: "unavailable" }`
 *
 * Privacy: the path filter is derived from the session DID server-side (see
 * ~/lib/stats) — no client input reaches the query. Responses are cached in
 * the Workers Cache API for 10 minutes under a per-DID digest key (the cache
 * is shared; key separation IS the isolation), and every response served to
 * the browser carries `Cache-Control: private, no-store` so no shared HTTP
 * cache downstream ever stores writer-private numbers.
 */
export const Route = createFileRoute("/api/stats")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const did = await readSessionDid(request, env.COOKIE_SECRET);
        if (!did || !isDid(did)) {
          return privateJson({ error: "unauthorized" }, 401);
        }

        const apiKey = env.POSTHOG_QUERY_API_KEY;
        const projectId = env.POSTHOG_PROJECT_ID;
        if (!apiKey || !projectId) return privateJson({ enabled: false });

        const cache = (globalThis as { caches?: { default?: Cache } }).caches
          ?.default;
        const key = await statsCacheKey(did);
        if (cache) {
          const hit = await cache.match(key);
          if (hit) {
            return new Response(hit.body, {
              status: 200,
              headers: {
                "content-type": "application/json",
                "cache-control": "private, no-store",
                "x-goldroad-cache": "HIT",
              },
            });
          }
        }

        // Display resolution is best-effort: without a handle the DID root
        // still covers the writer's pages (readers can browse either form).
        const handle = await resolveDidToHandle(did).catch(() => null);
        const stats: WriterStats = await fetchWriterStats({
          apiKey,
          projectId,
          roots: writerPathRoots(did, handle),
        });

        // Only healthy payloads cache — an upstream blip must not pin
        // "unavailable" for 10 minutes.
        if (cache && !("error" in stats)) {
          const stored = Response.json(stats);
          stored.headers.set(
            "cache-control",
            `max-age=${STATS_CACHE_TTL_SECONDS}`,
          );
          await cache.put(key, stored).catch(() => {});
        }
        const res = privateJson(stats);
        res.headers.set("x-goldroad-cache", "MISS");
        return res;
      },
    },
  },
});

/** JSON response that no shared HTTP cache may store — these payloads are
 * writer-private. (The Workers-cache copy above is stored under a per-DID
 * key with its own explicit max-age instead.) */
function privateJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
