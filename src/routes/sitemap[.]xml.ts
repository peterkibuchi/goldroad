import { createFileRoute } from "@tanstack/react-router";

import { escapeXml } from "~/lib/feed";
import { CANONICAL_ORIGIN } from "~/lib/origin";

/**
 * /sitemap.xml — first-party surfaces only, minted from the canonical origin
 * (never the request origin, so preview/workers.dev hostnames never leak into
 * crawler indexes).
 *
 * Publications and documents are deliberately NOT enumerated here: they are
 * third-party-authored and unbounded (any atproto author's records render on
 * the reading surfaces), so a complete sitemap is impossible and a partial one
 * would be misleading. Crawlers discover that content the way readers do —
 * through links, the per-publication RSS feeds (/@handle/rss.xml), and the
 * open network itself. robots.txt (public/robots.txt) points here and keeps
 * every reading surface crawlable.
 */

/** First-party pages worth indexing. Auth-gated app surfaces (/write,
 * /dashboard, /settings) and API/OAuth endpoints stay out by design. */
const FIRST_PARTY_PATHS = [
  "/",
  "/leaving-substack",
  "/privacy",
  "/terms",
  "/policies",
];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const urls = FIRST_PARTY_PATHS.map(
          (path) =>
            `  <url><loc>${escapeXml(`${CANONICAL_ORIGIN}${path}`)}</loc></url>`,
        ).join("\n");
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
            // Static-ish first-party list — cheap to render, safe to let
            // browsers and the edge hold for an hour via headers alone.
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
