/**
 * Session reads that also require the session to still EXIST server-side.
 *
 * The cookie is a self-contained bearer token: a signed `{did, iat}` payload
 * with a 30-day ceiling. Verifying it proves we issued it and that it isn't
 * ancient — it proves nothing about whether the writer has since signed out.
 *
 * Signing out revokes the upstream tokens and drops the `sess:<did>` row, but a
 * copy of the cookie taken beforehand stayed cryptographically valid for the
 * remainder of its 30 days. Only `/api/publish` noticed, because restoring the
 * OAuth session fails there; every endpoint reading OUR database trusted the
 * signature alone. That made "Sign out" — and even "Delete my account" — a
 * client-side gesture against an attacker holding the cookie, when those are
 * exactly the actions a person takes *because* they think it was exposed.
 *
 * So: endpoints that touch a writer's own data verify the signature AND that
 * the session row is still there. One indexed single-row read on an exact key.
 */
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { oauthKv } from "~/db/schema";
import { isDid } from "~/lib/atproto";
import { readSessionDid } from "~/lib/session";

/** `~/lib/oauth`'s D1Store prefixes session keys, so the row for a signed-in
 * writer is exactly `sess:<did>` — an exact key, never a scan. */
const SESSION_KEY_PREFIX = "sess:";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** True when a live session row exists for this DID. */
export async function hasLiveSession(
  db: DrizzleD1,
  did: string,
): Promise<boolean> {
  const row = await db
    .select({ k: oauthKv.k })
    .from(oauthKv)
    .where(eq(oauthKv.k, SESSION_KEY_PREFIX + did))
    .get();
  return row !== undefined;
}

/**
 * The signed-in writer's DID, or null when the cookie is missing, malformed,
 * expired, not a DID, or names a session that has since been signed out.
 *
 * A revoked-but-unexpired cookie is indistinguishable from no cookie at all,
 * which is the point: the caller's existing "not signed in" branch is already
 * the correct response.
 */
export async function readLiveSessionDid(
  request: Request,
  secret: string,
  db: DrizzleD1,
): Promise<string | null> {
  const did = await readSessionDid(request, secret);
  if (!did || !isDid(did)) return null;
  return (await hasLiveSession(db, did)) ? did : null;
}
