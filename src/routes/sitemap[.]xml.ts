import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { escapeXml } from "~/lib/feed";
import {
  selectSitemapPublications,
  sitemapPublicationUrl,
} from "~/lib/hosted-publications";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { env } from "cloudflare:workers";

/**
 * /sitemap.xml — first-party pages, then the publications this instance hosts,
 * all minted from the canonical origin (never the request origin, so
 * preview/workers.dev hostnames never leak into crawler indexes).
 *
 * The reading surfaces render any atproto author's records, so a complete list
 * of publications is impossible. The ones listed are those whose publication
 * record Goldroad wrote or found as its own while publishing a post (see
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
    return rows.flatMap(({ url, updatedAt }) => {
      const loc = sitemapPublicationUrl(url);
      if (!loc) return [];
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

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
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
            // One D1 read per response; crawlers fetch a sitemap a few times a
            // day, and an hour's delay on a new publication costs nothing.
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
