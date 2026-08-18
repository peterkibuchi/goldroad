/**
 * The cron's publisher: one claimed row → one record in the writer's repo.
 *
 * This is the half of scheduled publishing that needs the writer's identity, so
 * it is deliberately the only part that touches OAuth. The scheduling itself
 * (~/lib/scheduled-posts) is pure queries and a pure pass; keeping the session
 * restore out of there is what lets the retry ceiling, the per-tick cap and the
 * claim be tested without a PDS anywhere in sight.
 *
 * WHY A FAILURE HERE IS LOUD, ALWAYS. Nobody is watching at 09:00. The writer
 * has gone; there is no form to redirect, no status code anyone will read. So
 * every path out of this module ends in either a published record or a SENTENCE
 * — written to `scheduled_posts.last_error` and shown to the writer in the posts
 * manager. A scheduled post that silently never went out is the worst thing this
 * feature could do to someone, because they will believe they published.
 *
 * `client.restore(did)` failing is the case that matters most and the one with
 * the least room for cleverness: a revoked or expired refresh grant CANNOT be
 * fixed by trying again in an hour, so it fails the post for good rather than
 * spending three ticks pretending otherwise. A transient token-endpoint blip
 * lands in the same branch and costs the writer one press of "Publish now" —
 * which is the right side of that trade, because the alternative is a post that
 * stays "pending" while its moment passes.
 */
import { Client } from "@atcute/client";
import type { drizzle } from "drizzle-orm/d1";

import { isDid, resolveDidIdentity } from "~/lib/atproto";
import { selectDraft } from "~/lib/drafts";
import { createOAuthClient } from "~/lib/oauth";
import { CANONICAL_ORIGIN, ownOrigins } from "~/lib/origin";
import { publishStoredDraft } from "~/lib/publish-document";
import { readSurfaceWarmUrls, warmReadSurfaces } from "~/lib/read-cache";
import type {
  DuePost,
  PublishAttempt,
  ScheduledPublisher,
} from "~/lib/scheduled-posts";

type DrizzleD1 = ReturnType<typeof drizzle>;

/**
 * `ctx.waitUntil`, threaded down from the Worker entry — the only scope that
 * holds an ExecutionContext (src/server.ts). Optional so this module stays
 * callable, and testable, without one; absent, the warm is awaited instead.
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

/** The sentence a writer reads when their OAuth grant is no longer usable. It
 * names the cause, the consequence, and the one action that fixes it — a
 * scheduled post's failure notice is the whole of the support conversation. */
export const SESSION_LOST_REASON =
  "Goldroad couldn't use your connection to your data server, so this post did not go out — the sign-in may have expired, or been revoked from your account. Sign in again, then publish it now.";

export const DRAFT_GONE_REASON =
  "The draft this was scheduled from no longer exists, so there was nothing to publish.";

const READ_FAILED_REASON =
  "Goldroad couldn't read this draft just now. It will try again within the hour.";

const PDS_UNREACHABLE_REASON =
  "Goldroad couldn't reach your data server to publish this. It will try again within the hour.";

/**
 * Publishes one due post. Returns a verdict; never throws (the pass logs and
 * retries a thrown attempt, but a publisher that reports honestly is what lets
 * the pass distinguish "try again" from "tell them").
 *
 * URLs are minted from CANONICAL_ORIGIN, not from any request — there is no
 * request here, and a permanent record must not carry an infrastructure
 * hostname (see ~/lib/origin).
 */
export async function publishDuePost(
  db: DrizzleD1,
  post: DuePost,
  waitUntil?: WaitUntil,
): Promise<PublishAttempt> {
  // Our own column, checked anyway: a DID is interpolated into XRPC calls, and
  // the one query that produced this row is the one that isn't DID-scoped.
  if (!isDid(post.did))
    return {
      ok: false,
      retry: false,
      reason: "This scheduled post is not attached to a valid account.",
    };

  const client = createOAuthClient(CANONICAL_ORIGIN);
  let session: Awaited<ReturnType<typeof client.restore>>;
  try {
    session = await client.restore(post.did);
  } catch (err) {
    // Terminal on purpose — see the note at the top of this file.
    console.warn("scheduled publish: session restore failed", post.id, err);
    return { ok: false, retry: false, reason: SESSION_LOST_REASON };
  }

  // The draft, read with the ROW'S OWN DID in the WHERE — the point at which
  // the cron's one cross-writer query (`selectDuePosts`) becomes per-writer
  // again, before a single word of anyone's draft is read.
  let draft: Awaited<ReturnType<typeof selectDraft>>[number] | undefined;
  try {
    [draft] = await selectDraft(db, post.did, post.draftId);
  } catch (err) {
    console.error("scheduled publish: draft read failed", post.id, err);
    return { ok: false, retry: true, reason: READ_FAILED_REASON };
  }
  if (!draft) return { ok: false, retry: false, reason: DRAFT_GONE_REASON };

  const { handle, pds } = await resolveDidIdentity(post.did);
  // Without a PDS there is nowhere to write. Worth another hour: identity
  // resolution is a network call to somebody else's infrastructure.
  if (!pds) return { ok: false, retry: true, reason: PDS_UNREACHABLE_REASON };

  const outcome = await publishStoredDraft({
    rpc: new Client({ handler: session }),
    db,
    did: post.did,
    ident: handle ?? post.did,
    pds,
    origin: CANONICAL_ORIGIN,
    origins: ownOrigins(CANONICAL_ORIGIN),
    draft,
  });
  if (!outcome.ok)
    return { ok: false, retry: outcome.retry, reason: outcome.reason };

  // Warm the pages this publish just changed — the same delete-then-fetch the
  // interactive path runs, reached differently because there is no response
  // here to carry the URLs to the Worker entry (see readSurfaceWarmUrls).
  //
  // Without it a scheduled post's archive page and RSS feed stayed stale for
  // up to READ_CACHE_TTL_SECONDS after going out, which is the whole window in
  // which anyone is pointed at a freshly published piece.
  //
  // SUBREQUEST ARITHMETIC, because this shares one invocation's budget of 50
  // with every other cron job (~/lib/scheduled): a publish already spends ~4
  // (token refresh, DID/PDS resolution, publication lookup, createRecord), and
  // the warm adds 2 (the archive index and the new post's page; `cache.delete`
  // is not a subrequest). At the per-tick cap of five publishes that takes the
  // publishing pass from ~20 to ~30, leaving the jobs behind it about 20 —
  // enough for the report alert and the self-check, and the follower sample
  // was already the job that gets squeezed on a busy tick and self-heals next
  // hour. If the budget ever actually bites, MAX_PUBLISHES_PER_TICK is the
  // dial, not this.
  //
  // On `waitUntil` so it never delays the next due post; awaited when there is
  // no context, which is how the tests see it happen at all.
  //
  // The `.catch` is not decoration. The record is ALREADY LIVE in the writer's
  // repo by this point, and the pass around us treats a thrown publisher as
  // `retry: true` — so an exception escaping here would have the next tick
  // publish the same post a second time. A cache that went unwarmed costs one
  // cold render; a duplicate post costs the writer their own archive.
  const warm = warmReadSurfaces(
    readSurfaceWarmUrls({
      origin: CANONICAL_ORIGIN,
      ident: handle ?? post.did,
      rkey: outcome.rkey,
    }),
    { origin: CANONICAL_ORIGIN },
  ).catch((err) => {
    console.warn("scheduled publish: read-cache warm failed", post.id, err);
  });
  if (waitUntil) waitUntil(warm);
  else await warm;
  return { ok: true, rkey: outcome.rkey };
}

/** The publisher the cron pass calls, bound to a database — and to the
 * ExecutionContext's `waitUntil`, when the entry passed one down. */
export function cronPublisher(
  db: DrizzleD1,
  waitUntil?: WaitUntil,
): ScheduledPublisher {
  return (post) => publishDuePost(db, post, waitUntil);
}
