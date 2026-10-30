// @vitest-environment node
/**
 * Sign-in, sign-out and session expiry, end to end against real SQLite: the
 * callback and logout handlers, the session store the OAuth library writes
 * through, and the liveness check every authenticated route runs. Only the
 * OAuth client's network half is faked — its `callback` writes the session row
 * through the real store, the way the library does.
 */
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { oauthKv } from "~/db/schema";
import {
  backfillSessionExpiry,
  extendSessionRow,
  readLiveSessionDid,
  SESSION_IDLE_MS,
} from "~/lib/live-session";
import { D1SessionStore } from "~/lib/oauth";
import { purgeExpiredOauthKv } from "~/lib/scheduled";
import { signSession } from "~/lib/session";
import { Route as Logout } from "../routes/logout";
import { Route as Callback } from "../routes/oauth.callback";
import { handlerOf } from "./support/route-handler";
import { type SqliteD1, sqliteD1 } from "./support/sqlite-d1";
import { env } from "cloudflare:workers";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const ATTACKER = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
const SECRET = String(env.COOKIE_SECRET);
const ORIGIN = "http://127.0.0.1:3000";
const DAY = 24 * 60 * 60 * 1000;

/** Which account each pending state signs in, as the authorization server
 * would decide it. */
const pendingStates = new Map<string, string>();
const fakeClient = {
  callback: vi.fn(async (params: URLSearchParams) => {
    const did = pendingStates.get(params.get("state") ?? "");
    if (!did) throw new Error("unknown state");
    pendingStates.delete(params.get("state") ?? "");
    // The callback's client, the only one allowed to create the row.
    await new D1SessionStore(drizzle(env.DB as D1Database), true).set(did, {
      tokenSet: { sub: did },
    });
    return { session: { did }, state: { returnTo: "/home" } };
  }),
  // The library's revoke can throw before reaching its own row delete; the
  // handler must not depend on it.
  revoke: vi.fn(async () => {
    throw new Error("upstream revoke failed");
  }),
};
vi.mock("~/lib/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/oauth")>()),
  createOAuthClient: () => fakeClient,
}));

const callback = handlerOf(Callback, "GET");
const logout = handlerOf(Logout, "POST");

let d1: SqliteD1;
let originalDb: unknown;
beforeEach(() => {
  d1 = sqliteD1();
  originalDb = env.DB;
  env.DB = d1;
  pendingStates.clear();
  fakeClient.callback.mockClear();
});
afterEach(() => {
  env.DB = originalDb as D1Database;
});

const db = () => drizzle(d1);

/** The value of a cookie set on a response, or undefined. */
function setCookie(res: Response, name: string): string | undefined {
  for (const value of res.headers.getSetCookie()) {
    const [pair] = value.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

/** Completes a sign-in for `did` in a browser holding `cookie` (none if
 * empty). */
async function finishSignIn(
  did: string,
  opts: { state?: string; cookie?: string } = {},
) {
  const state = opts.state ?? `state-${Math.random()}`;
  pendingStates.set(state, did);
  return callback({
    request: new Request(`${ORIGIN}/oauth/callback?state=${state}&code=c`, {
      headers: opts.cookie ? { cookie: opts.cookie } : {},
    }),
  });
}

/** A browser that started its own sign-in and finished it: the session token. */
async function signIn(did = DID): Promise<string> {
  const state = `state-${Math.random()}`;
  const res = await finishSignIn(did, {
    state,
    cookie: `gr_oauth_state=${state}`,
  });
  const token = setCookie(res, "gr_session");
  if (!token) throw new Error("sign-in set no session cookie");
  return token;
}

function withSession(token: string, path = "/api/drafts", init?: RequestInit) {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { cookie: `gr_session=${token}` },
  });
}

const live = (token: string, now?: number) =>
  readLiveSessionDid(withSession(token), SECRET, db(), now);

function sessionRow(did = DID) {
  return d1.sqlite
    .prepare("select sid, expires_at from oauth_kv where k = ?")
    .get(`sess:${did}`) as { sid: string | null; expires_at: number | null };
}

describe("a sign-in is bound to the browser that started it", () => {
  it("refuses a callback replayed into a browser that never started it", async () => {
    // The attacker authorized their own account and sent the link onward.
    const res = await finishSignIn(ATTACKER, {
      state: "attackers-state",
      cookie: "",
    });

    expect(new URL(res.headers.get("location") ?? "", ORIGIN).search).toBe(
      "?error=signin_failed",
    );
    expect(setCookie(res, "gr_session")).toBeUndefined();
    // Refused before the code exchange: no session row for anyone, and the
    // attacker's state wasn't spent.
    expect(fakeClient.callback).not.toHaveBeenCalled();
    expect(sessionRow(ATTACKER)).toBeUndefined();
  });

  it("refuses it in a browser midway through its own, different sign-in", async () => {
    const res = await finishSignIn(ATTACKER, {
      state: "attackers-state",
      cookie: "gr_oauth_state=victims-own-state",
    });
    expect(setCookie(res, "gr_session")).toBeUndefined();
    expect(fakeClient.callback).not.toHaveBeenCalled();
  });

  it("signs in the browser that did start it, and drops the binding cookie", async () => {
    const res = await finishSignIn(DID, {
      state: "mine",
      cookie: "gr_oauth_state=mine",
    });
    expect(res.headers.get("location")).toBe("/home");
    expect(setCookie(res, "gr_oauth_state")).toBe("");
    const token = setCookie(res, "gr_session");
    expect(token && (await live(token))).toBe(DID);
  });
});

describe("a cookie from before a sign-out stays dead", () => {
  it("after sign-out then sign-in, only the new cookie works", async () => {
    const before = await signIn();
    expect(await live(before)).toBe(DID);

    const out = await logout({
      request: withSession(before, "/logout", { method: "POST" }),
    });
    expect(out.status).toBe(302);
    // Upstream revoke threw, and the row is gone anyway.
    expect(sessionRow()).toBeUndefined();
    expect(await live(before)).toBeNull();

    const after = await signIn();
    expect(await live(after)).toBe(DID);
    // The same DID, a new row: the copied cookie does not come back.
    expect(await live(before)).toBeNull();
  });

  it("lets a stale cookie clear itself but not end the current session", async () => {
    const stale = await signIn();
    await logout({
      request: withSession(stale, "/logout", { method: "POST" }),
    });
    const current = await signIn();

    const res = await logout({
      request: withSession(stale, "/logout", { method: "POST" }),
    });
    expect(setCookie(res, "gr_session")).toBe("");
    expect(await live(current)).toBe(DID);
  });

  it("keeps a second browser signed in when the first signs in again", async () => {
    // One session row per account, shared by every browser on it: a sign-in
    // elsewhere (or a token refresh) must not invalidate a live cookie.
    const laptop = await signIn();
    const phone = await signIn();
    expect(await live(laptop)).toBe(DID);
    expect(await live(phone)).toBe(DID);
  });

  it("refuses a correctly signed cookie naming another session id", async () => {
    await signIn();
    const forged = await signSession(DID, "not-the-rows-sid", SECRET);
    expect(await live(forged)).toBeNull();
  });
});

describe("idle sessions expire", () => {
  it("refuses an expired row, and the sweep deletes it, refresh token and all", async () => {
    const token = await signIn();
    const expiresAt = sessionRow().expires_at ?? 0;
    expect(expiresAt).toBeGreaterThan(Date.now() + SESSION_IDLE_MS - DAY);

    expect(await live(token, expiresAt + 1)).toBeNull();
    await purgeExpiredOauthKv(db(), expiresAt + 1);
    expect(sessionRow()).toBeUndefined();
  });

  it("slides the expiry forward with use, at most once a day", async () => {
    const token = await signIn();
    const signedInAt = Date.now();
    const first = sessionRow().expires_at;

    // An hour later: still fresh, nothing written.
    await live(token, signedInAt + 60 * 60 * 1000);
    expect(sessionRow().expires_at).toBe(first);

    // Ten days later the cookie is still inside its 30 days, and use moves
    // the row's expiry out to 30 days from now.
    const later = signedInAt + 10 * DAY;
    expect(await live(token, later)).toBe(DID);
    expect(sessionRow().expires_at).toBe(later + SESSION_IDLE_MS);
  });

  it("never revives an expired row, and never shortens a live one", async () => {
    await signIn();
    const now = Date.now();
    const far = now + 200 * DAY;
    await extendSessionRow(db(), DID, far, now);
    expect(sessionRow().expires_at).toBe(far);

    await extendSessionRow(db(), DID, now + DAY, now);
    expect(sessionRow().expires_at).toBe(far);

    // A token refresh writes through the store; it must not pull it back in.
    await new D1SessionStore(db()).set(DID, { tokenSet: { sub: DID } });
    expect(sessionRow().expires_at).toBe(far);

    await extendSessionRow(db(), DID, far + 400 * DAY, far + 1);
    expect(sessionRow().expires_at).toBe(far);
  });

  it("gives a lapsed row a new session id when the account signs in again", async () => {
    const old = await signIn();
    const oldSid = sessionRow().sid;
    d1.sqlite
      .prepare("update oauth_kv set expires_at = ? where k = ?")
      .run(Date.now() - 1, `sess:${DID}`);

    const fresh = await signIn();
    expect(sessionRow().sid).not.toBe(oldSid);
    expect(await live(fresh)).toBe(DID);
    expect(await live(old)).toBeNull();
  });
});

describe("rows written before session ids existed", () => {
  it("are refused until the writer signs in, then get an id", async () => {
    await db()
      .insert(oauthKv)
      .values({ k: `sess:${DID}`, v: "{}", expiresAt: null, sid: null });
    const legacy = await signSession(DID, "anything", SECRET);
    expect(await live(legacy)).toBeNull();

    const token = await signIn();
    expect(sessionRow().sid).not.toBeNull();
    expect(await live(token)).toBe(DID);
  });
});

describe("scheduled posts keep the session they publish with", () => {
  function schedule(did: string, dueAt: number) {
    d1.sqlite
      .prepare(
        "insert into scheduled_posts (id, did, draft_id, due_at, status, created_at, updated_at) values (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(crypto.randomUUID(), did, crypto.randomUUID(), dueAt, 0, 0);
  }

  it("holds a fresh sign-in open until 30 days past a pending post", async () => {
    // Scheduled, signed out, signed in again: the new row must still cover the
    // post, or the cron finds no session on the day.
    const due = Date.now() + 45 * DAY;
    schedule(DID, due);
    await signIn();
    expect(sessionRow().expires_at).toBe(due + SESSION_IDLE_MS);
  });

  it("gives rows written without an expiry one, and only session rows", async () => {
    const now = Date.now();
    const due = now + 90 * DAY;
    schedule(DID, due);
    d1.sqlite.exec(`insert into oauth_kv (k, v, expires_at) values
      ('sess:${DID}', '{}', null),
      ('sess:${ATTACKER}', '{}', null),
      ('state:abc', '{}', null)`);

    await backfillSessionExpiry(db(), now);
    const expiry = (k: string) =>
      (
        d1.sqlite
          .prepare("select expires_at from oauth_kv where k = ?")
          .get(k) as { expires_at: number | null }
      ).expires_at;
    expect(expiry(`sess:${DID}`)).toBe(due + SESSION_IDLE_MS);
    expect(expiry(`sess:${ATTACKER}`)).toBe(now + SESSION_IDLE_MS);
    expect(expiry("state:abc")).toBeNull();
  });
});

describe("a token refresh after sign-out", () => {
  it("doesn't put the deleted session back", async () => {
    const token = await signIn();
    await logout({
      request: withSession(token, "/logout", { method: "POST" }),
    });
    // A request that began refreshing before the sign-out finishes after it.
    await new D1SessionStore(db()).set(DID, { tokenSet: { sub: DID } });
    expect(sessionRow()).toBeUndefined();
  });
});

describe("sign-out when the database is unavailable", () => {
  it("still clears this browser's cookies", async () => {
    const token = await signIn();
    env.DB = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const res = await logout({
      request: withSession(token, "/logout", { method: "POST" }),
    });
    expect(res.status).toBe(302);
    expect(setCookie(res, "gr_session")).toBe("");
    expect(setCookie(res, "gr_signed_in")).toBe("");
  });
});

describe("sign-out ends the session the cookie names, whatever its age", () => {
  /** A cookie as code from before session ids signed it: `{did, iat}`. */
  async function preSidCookie(did = DID): Promise<string> {
    const b64 = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const payload = b64(
      new TextEncoder().encode(JSON.stringify({ did, iat: Date.now() })),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    return `${payload}.${b64(new Uint8Array(sig))}`;
  }

  it("ends a row from before session ids with the cookie from then", async () => {
    await db()
      .insert(oauthKv)
      .values({ k: `sess:${DID}`, v: "{}", expiresAt: null, sid: null });
    const old = await preSidCookie();
    await logout({ request: withSession(old, "/logout", { method: "POST" }) });
    expect(sessionRow()).toBeUndefined();
  });

  it("doesn't let that old cookie end a session signed in since", async () => {
    const old = await preSidCookie();
    const current = await signIn();
    await logout({ request: withSession(old, "/logout", { method: "POST" }) });
    expect(await live(current)).toBe(DID);
  });

  it("ends a row that has expired but not been swept yet", async () => {
    const token = await signIn();
    d1.sqlite
      .prepare("update oauth_kv set expires_at = ? where k = ?")
      .run(Date.now() - 1, `sess:${DID}`);
    await logout({
      request: withSession(token, "/logout", { method: "POST" }),
    });
    expect(sessionRow()).toBeUndefined();
  });
});

describe("a row left without an expiry", () => {
  it("keeps a scheduled post's session when use gives it one", async () => {
    // Older code writes no expiry on a token refresh. The next visit's slide
    // must still cover a post due further out than 30 days.
    const token = await signIn();
    const due = Date.now() + 60 * DAY;
    d1.sqlite
      .prepare(
        "insert into scheduled_posts (id, did, draft_id, due_at, status, created_at, updated_at) values (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(crypto.randomUUID(), DID, crypto.randomUUID(), due, 0, 0);
    d1.sqlite
      .prepare("update oauth_kv set expires_at = null where k = ?")
      .run(`sess:${DID}`);
    expect(await live(token)).toBe(DID);
    expect(sessionRow().expires_at).toBe(due + SESSION_IDLE_MS);
  });
});
