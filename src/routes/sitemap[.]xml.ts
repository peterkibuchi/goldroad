import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { escapeXml } from "~/lib/feed";
import {
  selectSitemapPublications,
  sitemapPublicationUrl,
} from "~/lib/hosted-publications";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { defaultCache } from "~/lib/workers-cache";
import { env } from "cloudflare:workers";

/**
 * /sitemap.xml — first-party pages, then the publications this instance hosts,
 * all minted from the canonical origin (never the request origin, so
 * preview/workers.dev hostnames never leak into crawler indexes).
 *
 * The reading surfaces render any atproto author's records, so a complete list
 * of publications is impossible. The ones listed belong to writers who have
 * published a post through Goldroad into a publication record of ours (see
 * ~/lib/hosted-publications), minus any writer on the takedown list. Posts are
 * not enumerated: each publication page links them, and so does its feed
 * (/@handle/rss.xml). robots.txt (public/robots.txt) points here.
 */

/** First-party pages worth indexing. Auth-gated app surfaces (/write,
 * /dashboard, /settings) and API/OAuth endpoints stay out by design. */
const FIRST_PARTY_PATHS = [
  "/",
  "/leaving-substack",
  "/open",
  "/privacy",
  "/terms",
  "/policies",
];

/** The hosted publications, or none when D1 can't answer: the first-party
 * half of the sitemap is worth serving on its own. */
async function hostedPublicationEntries(): Promise<string[]> {
  if (!env.DB) return [];
  try {
    const rows = await selectSitemapPublications(drizzle(env.DB));
    const seen = new Set<string>();
    return rows.flatMap(({ ident, updatedAt }) => {
      const loc = sitemapPublicationUrl(ident);
      // Two rows can name one page only if a handle moved between writers;
      // the newer publish (first, by the query's order) keeps it.
      if (!loc || seen.has(loc)) return [];
      seen.add(loc);
      const lastmod = updatedAt.toISOString().slice(0, 10);
      return [
        `  <url><loc>${escapeXml(loc)}</loc><lastmod>${lastmod}</lastmod></url>`,
      ];
    });
  } catch (err) {
    console.warn("sitemap publications read failed", err);
    return [];
  }
}

/** Seconds a data center keeps the built sitemap. A Worker response's
 * cache-control header doesn't put it in Cloudflare's cache, so this goes
 * through the Cache API: an anonymous loop of requests costs edge lookups,
 * not D1 reads. A writer taken down or newly published shows up within it. */
const SITEMAP_CACHE_SECONDS = 3600;
const SITEMAP_CACHE_KEY = "https://goldroad-sitemap.internal/v1";

async function buildSitemap(): Promise<Response> {
  const urls = [
    ...FIRST_PARTY_PATHS.map(
      (path) =>
        `  <url><loc>${escapeXml(`${CANONICAL_ORIGIN}${path}`)}</loc></url>`,
    ),
    ...(await hostedPublicationEntries()),
  ].join("\n");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": `public, max-age=${SITEMAP_CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
    },
  });
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const cache = defaultCache();
        const hit = await cache
          ?.match(SITEMAP_CACHE_KEY)
          .catch(() => undefined);
        if (hit) return hit;
        const fresh = await buildSitemap();
        await cache?.put(SITEMAP_CACHE_KEY, fresh.clone()).catch(() => {});
        return fresh;
      },
    },
  },
});
