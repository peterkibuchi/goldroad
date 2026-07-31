/**
 * Session cookie: `payload.signature` where payload = base64url(JSON{did,iat})
 * and signature = base64url(HMAC-SHA256(payload, secret)). The signature covers
 * the issued-at, so a token is only valid for MAX_AGE_SECONDS from issue — a
 * leaked cookie is no longer replayable forever (audit #9). The cookie still
 * carries ONLY the DID (+ its issue time); OAuth tokens and DPoP keys stay in
 * the D1-backed session store. WebCrypto only — must run on workerd.
 *
 * NOTE (backward-incompatible, deliberate): this replaces the old `did.HMAC`
 * format. Old cookies fail signature/shape verification and are treated as
 * signed-out — everyone re-logs in once. We've done a forced re-login before;
 * the security win is worth it.
 */

const COOKIE_NAME = "gr_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;
// Tolerate small clock skew on the issued-at so a token minted a moment ago on
// a slightly-ahead isolate isn't rejected as future-dated.
const CLOCK_SKEW_MS = 60_000;

const encoder = new TextEncoder();

type SessionPayload = { did: string; iat: number };

function isSessionPayload(value: unknown): value is SessionPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionPayload).did === "string" &&
    (value as SessionPayload).did.startsWith("did:") &&
    typeof (value as SessionPayload).iat === "number" &&
    Number.isFinite((value as SessionPayload).iat)
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const base64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  if (!secret) throw new Error("COOKIE_SECRET is not set");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Signs a DID + issue time into a session token: `base64url(json).base64url(hmac)`.
 * `nowMs` is injectable for tests; defaults to the wall clock. */
export async function signSession(
  did: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({ did, iat: nowMs } satisfies SessionPayload),
    ),
  );
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verifies a session token and its freshness; returns the DID or null.
 * Signature check is timing-safe (crypto.subtle.verify). Rejects when: the
 * shape is wrong, the signature doesn't match, the payload isn't a valid
 * {did, iat}, the issue time is in the future (beyond clock skew), or the token
 * is older than MAX_AGE_SECONDS. `nowMs` is injectable for tests.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const sep = token.lastIndexOf(".");
  if (sep <= 0 || sep === token.length - 1) return null;
  const payload = token.slice(0, sep);
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(token.slice(sep + 1));
  } catch {
    return null;
  }
  const key = await importHmacKey(secret, "verify");
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sig as unknown as BufferSource,
    encoder.encode(payload),
  );
  if (!ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null; // includes legacy `did.HMAC` tokens (payload isn't base64url JSON)
  }
  if (!isSessionPayload(parsed)) return null;
  const age = nowMs - parsed.iat;
  if (age < -CLOCK_SKEW_MS || age > MAX_AGE_MS) return null;
  return parsed.did;
}

/** Reads and verifies the session cookie from a request; returns the DID or null. */
export async function readSessionDid(
  request: Request,
  secret: string,
): Promise<string | null> {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    return verifySessionToken(part.slice(eq + 1).trim(), secret);
  }
  return null;
}

/** Set-Cookie value establishing a session. `secure` should be true on https origins. */
export function sessionSetCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

/**
 * A NON-sensitive companion cookie that only says "someone is signed in here".
 *
 * It carries no identity and grants nothing — the real session cookie stays
 * HttpOnly and is the only thing any endpoint trusts. This exists because
 * marketing pages are edge-cached and deliberately cookie-independent: the HTML
 * cannot vary per visitor, so a signed-in writer would be shown "Sign in". A
 * readable presence flag lets the client correct the label without fragmenting
 * the cache or exposing anything.
 */
export const SESSION_HINT_COOKIE = "gr_signed_in";

export function sessionHintSetCookie(secure: boolean): string {
  return `${SESSION_HINT_COOKIE}=1;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function sessionHintClearCookie(secure: boolean): string {
  return `${SESSION_HINT_COOKIE}=;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}

/** Every cookie a sign-out must drop, as Set-Cookie values. Returned together
 * so a new sign-out path cannot clear the session and leave the presence flag
 * behind, which would show a signed-out visitor a signed-in label. */
export function clearSessionCookies(secure: boolean): string[] {
  return [sessionClearCookie(secure), sessionHintClearCookie(secure)];
}

/** Set-Cookie value clearing the session. */
export function sessionClearCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}
