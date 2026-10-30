/**
 * Session cookie: `payload.signature` where payload =
 * base64url(JSON{did,sid,iat}) and signature = base64url(HMAC-SHA256(payload,
 * secret)). The signature covers the issued-at, so a token is only valid for
 * MAX_AGE_SECONDS from issue. `sid` names the server-side session row it was
 * issued against (see ~/lib/live-session): a new row after sign-out gets a new
 * sid, so a cookie from before can't come back to life. OAuth tokens and DPoP
 * keys stay in D1. WebCrypto only — must run on workerd.
 *
 * Cookies without a sid (the older `{did,iat}` and `did.HMAC` formats) fail
 * verification and read as signed-out, so everyone signs in again once.
 */

const COOKIE_NAME = "gr_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;
// Tolerate small clock skew on the issued-at so a token minted a moment ago on
// a slightly-ahead isolate isn't rejected as future-dated.
const CLOCK_SKEW_MS = 60_000;

const encoder = new TextEncoder();

type SessionPayload = { did: string; sid: string; iat: number };

/** What a verified cookie proves: who, and which session row it belongs to. */
export type SessionCookie = { did: string; sid: string };

function isSessionPayload(value: unknown): value is SessionPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionPayload).did === "string" &&
    (value as SessionPayload).did.startsWith("did:") &&
    typeof (value as SessionPayload).sid === "string" &&
    (value as SessionPayload).sid !== "" &&
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

/** A fresh session id: 128 random bits, base64url. */
export function newSessionId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Signs a DID, session id and issue time into a session token:
 * `base64url(json).base64url(hmac)`. `nowMs` is injectable for tests. */
export async function signSession(
  did: string,
  sid: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({ did, sid, iat: nowMs } satisfies SessionPayload),
    ),
  );
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

/** A token's payload when its signature verifies, or null. Signature check is
 * timing-safe (crypto.subtle.verify). */
async function verifiedPayload(
  token: string,
  secret: string,
): Promise<unknown> {
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
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null; // includes legacy `did.HMAC` tokens (payload isn't base64url JSON)
  }
}

function isFresh(iat: number, nowMs: number): boolean {
  const age = nowMs - iat;
  return age >= -CLOCK_SKEW_MS && age <= MAX_AGE_MS;
}

/**
 * Verifies a session token and its freshness; returns `{did, sid}` or null.
 * Rejects when: the shape is wrong, the signature doesn't match, the payload
 * isn't a valid {did, sid, iat}, the issue time is in the future (beyond clock
 * skew), or the token is older than MAX_AGE_SECONDS. `nowMs` is injectable for
 * tests.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<SessionCookie | null> {
  const parsed = await verifiedPayload(token, secret);
  if (!isSessionPayload(parsed) || !isFresh(parsed.iat, nowMs)) return null;
  return { did: parsed.did, sid: parsed.sid };
}

/**
 * The DID in a fresh, correctly signed cookie from before session ids: a
 * `{did, iat}` payload with no sid. Sign-out is its only use, to end a session
 * row that was written before sids existed (see `readSessionToEnd` in
 * ~/lib/live-session). Nothing else may accept one.
 */
export async function readPreSidSessionDid(
  request: Request,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const token = readCookie(request, COOKIE_NAME);
  if (token === null) return null;
  const parsed = await verifiedPayload(token, secret);
  if (typeof parsed !== "object" || parsed === null || "sid" in parsed)
    return null;
  const { did, iat } = parsed as { did?: unknown; iat?: unknown };
  if (typeof did !== "string" || !did.startsWith("did:")) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  return isFresh(iat, nowMs) ? did : null;
}

/** The named cookie's value from a request, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Reads and verifies the session cookie. Signature and age only — callers
 * that touch a writer's data want `readLiveSessionDid` (~/lib/live-session). */
export async function readSession(
  request: Request,
  secret: string,
): Promise<SessionCookie | null> {
  const token = readCookie(request, COOKIE_NAME);
  return token === null ? null : verifySessionToken(token, secret);
}

/** `readSession`'s DID alone. */
export async function readSessionDid(
  request: Request,
  secret: string,
): Promise<string | null> {
  return (await readSession(request, secret))?.did ?? null;
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

/**
 * Binds an OAuth sign-in to the browser that started it. /login stores the
 * flow's state id here; /oauth/callback refuses a state this browser didn't
 * start, so a callback link minted for someone else's account can't sign this
 * browser in. Scoped to the callback path and to the state's own 10 minutes.
 */
export const OAUTH_STATE_COOKIE = "gr_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 600;

export function oauthStateSetCookie(stateId: string, secure: boolean): string {
  return `${OAUTH_STATE_COOKIE}=${stateId}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/oauth/callback; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}`;
}

export function oauthStateClearCookie(secure: boolean): string {
  return `${OAUTH_STATE_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/oauth/callback; Max-Age=0`;
}

/** Set-Cookie value clearing the session. */
export function sessionClearCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}
