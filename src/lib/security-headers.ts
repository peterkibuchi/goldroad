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
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `script-src 'self' 'unsafe-inline' ${posthog}`,
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
