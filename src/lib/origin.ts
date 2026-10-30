/**
 * Canonical origin — the single source of truth for every absolute URL
 * Goldroad mints in production (OAuth client metadata, publication URLs,
 * announce links, head tags).
 *
 * Why this exists: the worker answers on more than one hostname
 * (trygoldroad.com via the zone route and goldroad.kibuchi.workers.dev, and
 * on staging its preview versions too). Deriving URLs from the
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

/** Cloudflare serves a Worker's preview versions on
 * `<version or alias>-<its workers.dev hostname>`, and they must keep serving
 * (a redirect to the canonical origin would make PR previews useless). Only a
 * Worker whose canonical origin IS its workers.dev hostname has any: staging
 * does, while production serves a custom domain with preview URLs off, so it
 * gets null and treats every other hostname as one to redirect. */
const PREVIEW_HOST_SUFFIX = CANONICAL_HOST.endsWith(".workers.dev")
  ? `-${CANONICAL_HOST}`
  : null;

/**
 * CSRF defense-in-depth for mutating handlers, shared by every one of them:
 * SameSite=Lax already keeps the session cookie off cross-site POSTs, so this
 * only matters for legacy browsers — but it's one header comparison. Browsers
 * send Origin on all POST/DELETE (same-origin included); absent means a
 * non-browser client, which the cookie requirement already gates.
 *
 * Compared against the REQUEST's origin, not CANONICAL_ORIGIN: the worker
 * legitimately answers on preview and loopback hostnames, and a form posted
 * from the page that served it is same-origin on all of them.
 */
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

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
 * Hostname and scheme canonicalization for the server entry. Production
 * requests on a non-canonical hostname (i.e. goldroad.kibuchi.workers.dev)
 * redirect to the same path + query on CANONICAL_ORIGIN, and plain-http
 * requests to https on the same host: 301 for GET and HEAD, 308 otherwise. Returns null when the request should be served: dev
 * loopback, and https on the canonical hostname or, when that is a
 * workers.dev hostname, one of its preview versions (PREVIEW_HOST_SUFFIX).
 *
 * The scheme comes from the `cf-visitor` header, NOT from request.url:
 * `wrangler dev` on the built worker presents the zone host over plain http
 * (local_protocol), so upgrading on request.url's scheme would loop local
 * preview forever (verified 2026-07-24). The Cloudflare edge sets cf-visitor
 * on real traffic only. The zone's "Always Use HTTPS" setting does the same
 * job one hop earlier, but it lives in the dashboard, not in this repo.
 */
export function canonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (isLoopbackOrigin(url.origin)) return null;
  const known =
    url.hostname === CANONICAL_HOST ||
    (PREVIEW_HOST_SUFFIX !== null &&
      url.hostname.endsWith(PREVIEW_HOST_SUFFIX));
  const plainHttp = visitorScheme(request) === "http";
  if (known && !plainHttp) return null;
  // Hostname, not host: a port on a plain-http request has no https twin.
  const origin = known ? `https://${url.hostname}` : CANONICAL_ORIGIN;
  return new Response(null, {
    // 308 keeps a POST a POST; a 301 turns it into a GET.
    status: request.method === "GET" || request.method === "HEAD" ? 301 : 308,
    headers: { location: `${origin}${url.pathname}${url.search}` },
  });
}

/** The scheme the visitor connected with, per the Cloudflare edge's
 * `cf-visitor: {"scheme":"http"}` header; null when absent or unreadable. */
function visitorScheme(request: Request): string | null {
  try {
    const visitor = JSON.parse(request.headers.get("cf-visitor") ?? "null");
    return typeof visitor?.scheme === "string" ? visitor.scheme : null;
  } catch {
    return null;
  }
}

/**
 * A URL minted on a legacy origin, moved onto the canonical one; any other URL
 * comes back unchanged. Early records still carry those hostnames, which now
 * only redirect here, and a canonical tag that points at a redirect sends
 * search engines two answers to one question.
 */
export function onCanonicalOrigin(url: string): string {
  for (const origin of LEGACY_ORIGINS) {
    if (url === origin || url.startsWith(`${origin}/`))
      return CANONICAL_ORIGIN + url.slice(origin.length);
  }
  return url;
}

/** Is this URL on the canonical origin (after onCanonicalOrigin)? */
export function isCanonicalOriginUrl(url: string): boolean {
  return url === CANONICAL_ORIGIN || url.startsWith(`${CANONICAL_ORIGIN}/`);
}

/**
 * A writer's reading page here: their publication, or one post on it. The
 * ident is lowercased because handles are case-insensitive (and the DIDs
 * atproto supports are lowercase already), so /@Writer.example and
 * /@writer.example name one page with one address.
 */
export function readerPageUrl(ident: string, rkey?: string): string {
  const page = `${CANONICAL_ORIGIN}/@${encodeURIComponent(ident.toLowerCase())}`;
  return rkey ? `${page}/${encodeURIComponent(rkey)}` : page;
}
