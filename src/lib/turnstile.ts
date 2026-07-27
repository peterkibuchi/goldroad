/**
 * Server-side Cloudflare Turnstile verification for the unauthenticated
 * intake endpoints (/api/waitlist, /api/report). Entirely env-gated:
 *
 * - `TURNSTILE_SECRET` unset (the default) → `checkTurnstile` passes every
 *   request through, exactly the pre-Turnstile behavior.
 * - Secret set → the request must carry a widget token, which is verified
 *   against the siteverify endpoint. Any failure — missing token, rejected
 *   token, upstream timeout — reads as "not verified": the callers answer
 *   with the same indistinguishable 400 the honeypot path uses, so bots
 *   can't tell which tripwire caught them.
 *
 * Fail-closed on siteverify outages is deliberate: the endpoints this gates
 * are unauthenticated writes, and the worker runs on Cloudflare next door to
 * siteverify — availability risk is minimal, abuse risk is not.
 *
 * Tokens are single-use secrets in transit: never log them.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** siteverify must answer within this budget or we treat it as a failure. */
const VERIFY_TIMEOUT_MS = 5_000;

/** Turnstile tokens are documented to stay well under this; anything larger
 * is garbage and gets rejected before we spend a fetch on it. */
const MAX_TOKEN_LENGTH = 2_048;

type Fetcher = typeof fetch;

/**
 * Verifies one widget token against siteverify. `remoteIp` (from the
 * CF-Connecting-IP header) is forwarded when present so Cloudflare can bind
 * the check to the visitor. Returns false on any non-success: rejected token,
 * non-2xx, malformed body, network error, or timeout.
 */
export async function verifyTurnstileToken(
  secret: string,
  token: string,
  remoteIp: string | null,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetcher(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    // Timeout or network failure — fail closed (see module comment). The
    // error is not logged with any request detail so a token can never leak.
    return false;
  }
}

/**
 * The env-gate the intake handlers call. Truth table:
 *
 * - no secret configured → true (feature off, request passes through)
 * - secret + missing/non-string/oversized token → false (no fetch spent)
 * - secret + token → the siteverify verdict
 */
export async function checkTurnstile(
  secret: string | undefined,
  token: unknown,
  remoteIp: string | null,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  if (!secret) return true;
  if (typeof token !== "string" || token.length === 0) return false;
  if (token.length > MAX_TOKEN_LENGTH) return false;
  return verifyTurnstileToken(secret, token, remoteIp, fetcher);
}

/**
 * Pulls the widget token out of a parsed (but pre-zod) JSON body. The token
 * rides alongside the form fields as `turnstileToken`; the payload schemas
 * deliberately don't know about it — anti-bot plumbing stays out of the data
 * contract.
 */
export function tokenFromBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>).turnstileToken;
}
