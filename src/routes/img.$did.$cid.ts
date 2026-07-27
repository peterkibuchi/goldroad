import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { assertPublicHttpsUrl, isDid, resolveDidToPds } from "~/lib/atproto";
import {
  isAllowedImageMime,
  isBlobCid,
  MAX_SERVED_IMAGE_BYTES,
  readBodyCapped,
} from "~/lib/blob";
import { anyHidden } from "~/lib/moderation";
import { env } from "cloudflare:workers";

/**
 * Image proxy: serves a repo blob (cover images) from the owner's PDS via
 * com.atproto.sync.getBlob, fronted by the Workers Cache API (free tier —
 * NOT R2). Same-origin so reader pages and og:image never
 * expose PDS hostnames, and so responses are cacheable at our edge.
 *
 * Threat model (this route fetches from a DID-derived host):
 * - SSRF: the PDS endpoint comes from a DID document (attacker-influenced) —
 *   assertPublicHttpsUrl gates it, redirects are never followed.
 * - Content smuggling: only allowlisted raster MIME types are served (SVG is
 *   script-capable and excluded), with nosniff + a no-execution CSP.
 * - Resource exhaustion: bodies are read with a hard streaming cap; a
 *   hostile PDS can't balloon worker memory.
 * Every rejection is a plain 404 — the route never confirms what exists.
 */

/** Serve cap: NOT the lexicon's 1MB write cap — live third-party covers
 * exceed it several-fold (see MAX_SERVED_IMAGE_BYTES). Hard memory bound. */
const MAX_SERVED_BYTES = MAX_SERVED_IMAGE_BYTES;

const NOT_FOUND = () =>
  new Response("Not found", {
    status: 404,
    headers: {
      // Negative results are cacheable briefly at the browser only — a PDS
      // flake shouldn't poison the edge cache for a real image.
      "cache-control": "no-store",
    },
  });

/** Takedown response (moderation kit): a blob whose author is on the hide-list.
 * Never cached, so lifting the takedown restores service immediately. */
const UNAVAILABLE = () =>
  new Response("This content is unavailable", {
    status: 451,
    headers: { "cache-control": "no-store" },
  });

export const Route = createFileRoute("/img/$did/$cid")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        // A lone "%" in the path makes decodeURIComponent throw URIError —
        // that too must be a plain 404, not a 5xx (adopted from review).
        let did: string;
        let cid: string;
        try {
          did = decodeURIComponent(params.did);
          cid = decodeURIComponent(params.cid);
        } catch {
          return NOT_FOUND();
        }
        if (!isDid(did) || !isBlobCid(cid)) return NOT_FOUND();

        // Takedown check BEFORE the cache lookup: /img caches immutably for a
        // year, so a post-cache hide would otherwise keep serving. Checks BOTH
        // the DID (author-level hide covers all their blobs) AND the raw CID,
        // so a record-level (AT-URI) takedown can also hide its cover image by
        // adding a hide row keyed on the cover's CID (see scripts/takedown.mjs).
        // env.DB is absent in unit tests — anyHidden then no-ops via the guard.
        if (env.DB) {
          const hidden = await anyHidden(drizzle(env.DB), [did, cid]).catch(
            () => false,
          );
          if (hidden) return UNAVAILABLE();
        }

        // Blobs are CID-addressed (immutable), so cache on the normalized
        // URL and serve forever. `caches.default` is the Workers Cache API
        // (absent from the DOM CacheStorage type, hence the cast) —
        // feature-detected so unit tests and node tooling can import this.
        const cacheUrl = new URL(request.url);
        cacheUrl.search = "";
        const cache = (globalThis as { caches?: { default?: Cache } }).caches
          ?.default;
        const cached = await cache?.match(cacheUrl);
        if (cached) return cached;

        let blobUrl: URL;
        try {
          const pds = await resolveDidToPds(did);
          const query = new URLSearchParams({ cid, did });
          // Defense in depth: the PDS origin came from a DID document.
          blobUrl = assertPublicHttpsUrl(
            `${pds}/xrpc/com.atproto.sync.getBlob?${query}`,
          );
        } catch {
          return NOT_FOUND();
        }

        // Never follow redirects — a public PDS host could bounce internal.
        const upstream = await fetch(blobUrl, { redirect: "manual" }).catch(
          () => null,
        );
        if (!upstream?.ok) {
          await upstream?.body?.cancel().catch(() => {});
          return NOT_FOUND();
        }
        const mime = upstream.headers.get("content-type") ?? "";
        if (!isAllowedImageMime(mime)) {
          await upstream.body?.cancel().catch(() => {});
          return NOT_FOUND();
        }
        const bytes = await readBodyCapped(upstream, MAX_SERVED_BYTES);
        if (!bytes) return NOT_FOUND();

        const response = new Response(bytes, {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            // Serve the bare validated type, not the raw upstream header
            // (parameters could smuggle surprises past the allowlist).
            "content-type": mime.split(";")[0].trim().toLowerCase(),
            "content-security-policy": "default-src 'none'",
            // og:image consumers and other origins may embed these directly.
            "cross-origin-resource-policy": "cross-origin",
            "x-content-type-options": "nosniff",
          },
        });
        await cache?.put(cacheUrl, response.clone()).catch(() => {});
        return response;
      },
    },
  },
});
