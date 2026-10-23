/**
 * Session reads that also require the session to still EXIST server-side.
 *
 * The cookie is a signed `{did, sid, iat}` with a 30-day ceiling. Verifying it
 * proves we issued it; it proves nothing about whether the writer has since
 * signed out. So everything that touches a writer's own data — API endpoints
 * AND page loaders — also checks the `sess:<did>` row: it must exist, carry the
 * cookie's sid, and not have expired.
 *
 * The sid is minted when the row is created and kept while it lives, so every
 * browser a writer signs in on shares it. Sign-out deletes the row; the next
 * sign-in creates a new one with a new sid, and a cookie copied before the
 * sign-out stays dead.
 *
 * Rows expire after SESSION_IDLE_MS without use (a reader who signed in once
 * doesn't keep a refresh token forever), and the hourly sweep in
 * ~/lib/scheduled deletes them. Use slides the expiry forward, at most one
 * write a day per writer. It never moves backwards, and it never falls short
 * of 30 days past the writer's last pending scheduled post, because the cron
 * publishes with this session (see `sessionExpiryFloor`).
 *
 * If you are adding an endpoint and reaching for `readSessionDid` because it
 * takes fewer arguments: that is the wrong one. Use this.
 */
import { and, eq, gt, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { oauthKv, scheduledPosts } from "~/db/schema";
import { isDid } from "~/lib/atproto";
import { readSession } from "~/lib/session";

/** `~/lib/oauth`'s D1Store prefixes session keys, so the row for a signed-in
 * writer is exactly `sess:<did>` — an exact key, never a scan. */
const SESSION_KEY_PREFIX = "sess:";

/** How long a session row lives without use. Not shorter than the cookie's
 * 30 days: a row written at sign-in must outlive every cookie issued for it. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Slide the expiry only once it has lost this much, so reads stay reads. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

type DrizzleD1 = ReturnType<typeof drizzle>;

/**
 * The earliest the session row for `did` (an SQL expression) may expire as of
 * `nowMs`: SESSION_IDLE_MS from now, or that long past the writer's last
 * pending scheduled post, whichever is later.
 */
export function sessionExpiryFloor(did: SQL, nowMs: number): SQL {
  return sql`max(${nowMs + SESSION_IDLE_MS}, coalesce((select max(${scheduledPosts.dueAt}) from ${scheduledPosts} where ${scheduledPosts.did} = ${did} and ${scheduledPosts.status} = 'pending'), 0) + ${SESSION_IDLE_MS})`;
}

/**
 * Gives session rows written without an expiry one, so the sweep can reach
 * them. Every session write sets one; this catches rows written by older code
 * (including during the gap between a migration and the deploy that needs it).
 */
export function backfillSessionExpiry(db: DrizzleD1, nowMs: number) {
  return db
    .update(oauthKv)
    .set({ expiresAt: sessionExpiryFloor(sql`substr(${oauthKv.k}, 6)`, nowMs) })
    .where(
      and(
        sql`${oauthKv.k} like ${`${SESSION_KEY_PREFIX}%`}`,
        isNull(oauthKv.expiresAt),
      ),
    );
}

/**
 * Moves the writer's session expiry out to `untilMs`, never in, and never
 * revives a row that has already expired.
 */
export async function extendSessionRow(
  db: DrizzleD1,
  did: string,
  untilMs: number,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .update(oauthKv)
    .set({ expiresAt: untilMs })
    .where(
      and(
        eq(oauthKv.k, SESSION_KEY_PREFIX + did),
        or(
          isNull(oauthKv.expiresAt),
          and(gt(oauthKv.expiresAt, nowMs), lt(oauthKv.expiresAt, untilMs)),
        ),
      ),
    );
}

/** The session id on the writer's live row, or null when there is none. */
export async function readSessionRowSid(
  db: DrizzleD1,
  did: string,
): Promise<string | null> {
  const row = await db
    .select({ sid: oauthKv.sid })
    .from(oauthKv)
    .where(eq(oauthKv.k, SESSION_KEY_PREFIX + did))
    .get();
  return row?.sid ?? null;
}

/**
 * The signed-in writer's DID, or null when the cookie is missing, malformed,
 * expired, not a DID, or names a session that has since been signed out or
 * replaced.
 *
 * A revoked-but-unexpired cookie is indistinguishable from no cookie at all,
 * which is the point: the caller's existing "not signed in" branch is already
 * the correct response.
 */
export async function readLiveSessionDid(
  request: Request,
  secret: string,
  db: DrizzleD1,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const cookie = await readSession(request, secret);
  if (!cookie || !isDid(cookie.did)) return null;
  const row = await db
    .select({ sid: oauthKv.sid, expiresAt: oauthKv.expiresAt })
    .from(oauthKv)
    .where(eq(oauthKv.k, SESSION_KEY_PREFIX + cookie.did))
    .get();
  if (!row || row.sid === null || row.sid !== cookie.sid) return null;
  if (row.expiresAt !== null && row.expiresAt <= nowMs) return null;

  if (
    row.expiresAt === null ||
    row.expiresAt < nowMs + SESSION_IDLE_MS - TOUCH_AFTER_MS
  ) {
    // The session is live either way; a failed slide only means the next
    // request tries again.
    try {
      await extendSessionRow(db, cookie.did, nowMs + SESSION_IDLE_MS, nowMs);
    } catch (err) {
      console.warn("session expiry slide failed", err);
    }
  }
  return cookie.did;
}
