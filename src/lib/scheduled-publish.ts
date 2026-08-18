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
import {
  type AnnounceReport,
  publishStoredDraft,
} from "~/lib/publish-document";
import type {
  DuePost,
  PublishAttempt,
  ScheduledPublisher,
} from "~/lib/scheduled-posts";

type DrizzleD1 = ReturnType<typeof drizzle>;

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
    // The decision the writer made when they scheduled this, read off the row
    // (~/lib/scheduled-posts). Their account setting is deliberately not
    // consulted here — see `announce` in ~/db/schema.
    announce: { requested: post.announce, source: "schedule" },
  });
  if (outcome.ok)
    return {
      ok: true,
      rkey: outcome.rkey,
      announceProblem: announceProblem(post, outcome.announce),
    };
  return { ok: false, retry: outcome.retry, reason: outcome.reason };
}

/**
 * The operator's sentence when a scheduled post published but its announce did
 * not — or undefined when there is nothing to say.
 *
 * A SKIP IS NOT A FAILURE and never appears here. "This was an import" and "the
 * writer turned announcing off" are the guards working; alerting on them would
 * teach an operator to ignore the channel. `over_budget` is the interesting
 * middle case and is deliberately also silent: it is a cap we chose, it is in the
 * pass's log line, and the writer can see the post has no announcement and press
 * the button. What alerts is a broken promise — a refused write, a grant that has
 * gone stale, or a post that exists while the document does not say so.
 */
function announceProblem(
  post: DuePost,
  report: AnnounceReport,
): string | undefined {
  if (report.state === "skipped") return undefined;
  if (report.state === "failed")
    return report.reason === "scope"
      ? `scheduled post ${post.id} published but could not be announced: the writer's sign-in predates the Bluesky post permission`
      : `scheduled post ${post.id} published but its announce was refused (${report.detail ?? report.reason})`;
  // Announced, but the document does not carry the reference — the state that
  // makes a later duplicate possible (see ~/lib/announce).
  if (!report.wroteBack)
    return `scheduled post ${post.id} was announced but the post reference could not be written back to the document`;
  return undefined;
}

/** The publisher the cron pass calls, bound to a database. */
export function cronPublisher(db: DrizzleD1): ScheduledPublisher {
  return (post) => publishDuePost(db, post);
}
