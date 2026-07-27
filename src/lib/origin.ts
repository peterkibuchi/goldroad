/**
 * Canonical origin — the single source of truth for every absolute URL
 * Goldroad mints in production (OAuth client metadata, publication URLs,
 * announce links, head tags).
 *
 * Why this exists: the worker answers on more than one hostname
 * (trygoldroad.com via the zone route, goldroad.kibuchi.workers.dev, and
 * *-goldroad.kibuchi.workers.dev preview versions). Deriving URLs from the
 * request origin baked workers.dev into permanent records and into the OAuth
 * client_id — so when the workers.dev hostname went dark for a day
 * (2026-07-24: declaring `routes` without `workers_dev: true` disables it on
 * deploy), every stored URL pointed at a dead hostname. Brand-owned URLs in
 * permanent records must not depend on infrastructure hostnames: production
 * URLs now always mint from CANONICAL_ORIGIN.
 *
 * Dev is the one exception: atproto loopback OAuth (RFC 8252) requires
 * 127.0.0.1 redirect URIs, so loopback request origins pass through untouched.
 *
 * Self-host / fork override: the canonical origin is read from the build-time
 * `VITE_PUBLIC_ORIGIN` env var (see .env.example), defaulting to the hosted
 * instance's origin. Set it to your own public origin when self-hosting so
 * minted URLs and the OAuth client_id point at your deployment, not ours.
 *
 * Pure module — no `cloudflare:workers` import, so tests can import it.
 */

export const CANONICAL_ORIGIN =
  import.meta.env.VITE_PUBLIC_ORIGIN || "https://trygoldroad.com";

const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).hostname;

/** Origins we historically minted publication URLs from. Records created
 * before the canonical-origin migration carry these prefixes; the ownership
 * guard must keep recognizing them as ours (and /settings + /dashboard offer
 * a one-click move to CANONICAL_ORIGIN). Append-only — never remove entries
 * while records referencing them can exist. */
export const LEGACY_ORIGINS = ["https://goldroad.kibuchi.workers.dev"] as const;

/** Versioned preview deploys (wrangler versions upload) answer on
 * <version>-goldroad.kibuchi.workers.dev — they must keep serving (a redirect
 * to production would make PR previews useless). */
const PREVIEW_HOST_SUFFIX = "-goldroad.kibuchi.workers.dev";

export function isLoopbackOrigin(origin: string): boolean {
  const { hostname } = new URL(origin);
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/**
 * The origin production URLs are minted from. Loopback (dev) keeps the
 * request origin — loopback OAuth and local links must stay on 127.0.0.1 —
 * everything else (workers.dev, previews) mints against CANONICAL_ORIGIN.
 */
export function canonicalOrigin(requestOrigin: string): string {
  return isLoopbackOrigin(requestOrigin) ? requestOrigin : CANONICAL_ORIGIN;
}

/**
 * Every origin whose publication URLs count as Goldroad-managed — the
 * ownership guard (isOwnPublicationUrl) matches against these. Canonical +
 * legacy always; in dev the loopback request origin too, so locally created
 * records stay editable locally.
 */
export function ownOrigins(requestOrigin: string): readonly string[] {
  return isLoopbackOrigin(requestOrigin)
    ? [requestOrigin, CANONICAL_ORIGIN, ...LEGACY_ORIGINS]
    : [CANONICAL_ORIGIN, ...LEGACY_ORIGINS];
}

/**
 * Hostname canonicalization for the server entry: production requests on a
 * non-canonical hostname (i.e. goldroad.kibuchi.workers.dev) 301 to the same
 * path + query on CANONICAL_ORIGIN. Returns null when the request should be
 * served: dev loopback, the canonical host, and versioned preview hostnames.
 *
 * HOSTNAME only, deliberately not protocol: `wrangler dev` on the built
 * worker presents the zone host over plain http (local_protocol), so an
 * http→https upgrade here would loop local preview forever (verified
 * 2026-07-24). http→https belongs to the Cloudflare edge (Always Use HTTPS).
 */
export function canonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (isLoopbackOrigin(url.origin)) return null;
  if (url.hostname === CANONICAL_HOST) return null;
  if (url.hostname.endsWith(PREVIEW_HOST_SUFFIX)) return null;
  return new Response(null, {
    status: 301,
    headers: { location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}` },
  });
}
