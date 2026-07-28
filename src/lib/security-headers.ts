/**
 * Security-header baseline for HTML document responses (audit finding #4).
 * Applied in the server entry (src/server.ts), the one place every response
 * flows through — the natural home, alongside canonicalRedirect.
 *
 * Scope: ONLY text/html responses. JSON APIs, OAuth metadata, redirects, and
 * the /img proxy (which sets its own `default-src 'none'` CSP + CORP) are left
 * untouched, so this never double-applies or conflicts with /img.
 *
 * The load-bearing win is X-Frame-Options + `frame-ancestors 'none'`: without
 * them the authenticated surfaces (/write, /dashboard, /settings) are framable,
 * so a publish/delete/logout form is clickjackable. HSTS asserts transport
 * security from the app (not just Cloudflare's "Always Use HTTPS").
 */

const POSTHOG_INGEST = "https://us.i.posthog.com";
const POSTHOG_ASSETS = "https://us-assets.i.posthog.com";
/** Cloudflare Turnstile (env-gated anti-bot on the waitlist/report forms)
 * loads its script from and renders its challenge iframe on this origin.
 * Allowed unconditionally: harmless while the widget is off (nothing loads
 * it), required the moment VITE_PUBLIC_TURNSTILE_SITE_KEY is set. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Content-Security-Policy for the app's HTML. Built empirically against what
 * the pages actually load (verified via the built worker + browser console):
 *
 * - script-src 'unsafe-inline': TanStack Start emits inline hydration/state
 *   <script> tags and BlockNote injects styles at runtime; there is no nonce
 *   plumbing. Reader markdown already renders with raw HTML inert (react-markdown,
 *   no rehype-raw), so CSP is defence-in-depth + clickjacking +
 *   transport here, NOT the primary XSS control. No 'unsafe-eval' — nothing in
 *   the bundle needs it (React 19 + Compiler, TanStack, BlockNote, PostHog-core).
 * - img-src allows https: + data: + blob: — writers' markdown can embed remote
 *   images (react-markdown → <img>), the cover picker previews via blob:/data:,
 *   and reader covers come through same-origin /img.
 * - PostHog hosts (optional analytics) are allowed in script-/connect-src; the
 *   directives are harmless when no key is set. `posthogHost` overrides the
 *   ingest origin (VITE_PUBLIC_POSTHOG_HOST) for reverse-proxied setups.
 * - Turnstile (optional anti-bot) needs script-src for api.js and frame-src
 *   for the challenge iframe. frame-src is stated explicitly because adding
 *   the Turnstile origin means default-src no longer covers it; 'self' is
 *   kept so a future same-origin frame doesn't silently break.
 */
export function buildContentSecurityPolicy(
  posthogHost: string = POSTHOG_INGEST,
): string {
  const posthog = [
    ...new Set([posthogHost, POSTHOG_INGEST, POSTHOG_ASSETS]),
  ].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // 'self' alone breaks sign-in: Chrome enforces form-action on the redirect
    // that FOLLOWS a form submission, and the /login POST 302s to the user's
    // own PDS authorize page — an arbitrary per-user https origin that cannot
    // be allowlisted ahead of time. https: keeps javascript:/data:/http:
    // form targets blocked while allowing that OAuth hop.
    "form-action 'self' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    `script-src 'self' 'unsafe-inline' ${posthog} ${TURNSTILE_ORIGIN}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${posthog}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Attaches the security-header baseline to a response IF it is an HTML
 * document; anything else is returned untouched. `csp` is the policy string to
 * assert, or null to omit CSP (dev, where a strict CSP would break Vite HMR —
 * verify the prod CSP against the built worker instead).
 */
export function withSecurityHeaders(
  response: Response,
  csp: string | null,
): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return response;
  // Reconstruct: a handler/cache response may carry immutable headers.
  const res = new Response(response.body, response);
  const h = res.headers;
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-frame-options", "DENY");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("cross-origin-opener-policy", "same-origin");
  if (csp) h.set("content-security-policy", csp);
  return res;
}
