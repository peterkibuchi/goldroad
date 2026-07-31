/**
 * Scheduled publishing — the D1 queries behind it, and the per-tick pass the
 * hourly cron runs.
 *
 * OWNERSHIP, and the one deliberate exception. Every writer-facing query here
 * pairs its keys with the session DID in the WHERE, exactly as ~/lib/drafts and
 * ~/lib/import-store do, so a caller can never reach another writer's schedule.
 * `selectDuePosts` is the exception and the only one: the cron publishes on
 * behalf of everybody, so it selects across DIDs by design. It is called from
 * the cron and nowhere else, it returns no draft content, and everything it
 * hands downstream is re-scoped by DID the moment a row's draft is read.
 *
 * WHAT MAKES A CRON FIRING HOURS LATER SAFE. Three things, in this order:
 *   1. A row is CLAIMED before any work happens (`claimDuePost`) — a
 *      conditional UPDATE that only one caller can win. See its comment for
 *      what that closes and what it does not.
 *   2. Every attempt is counted and every failure is written down in words the
 *      writer can read. A scheduled post that silently never went out is the
 *      worst outcome this feature has; a row that says why is the whole point.
 *   3. Nothing retries forever (MAX_PUBLISH_ATTEMPTS) and nothing is stranded
 *      by a tick that died holding a lease (`releaseStaleClaims`).
 *
 * SHAPE, as in ~/lib/follower-snapshots: everything is either a drizzle query
 * builder (awaitable, and verifiable via `.toSQL()` without a live D1) or a
 * pure function. The pass takes a `ScheduledPostStore` and a publisher, so it
 * can be exercised end to end against plain objects — no D1, no PDS, no OAuth.
 */
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { drafts, scheduledPosts } from "~/db/schema";

type DrizzleD1 = ReturnType<typeof drizzle>;

/**
 * Due posts published per tick.
 *
 * The cron handler shares one hourly invocation — a ~10 ms CPU budget and 50
 * subrequests — with four other jobs (~/lib/scheduled), and a single publish
 * spends several subrequests: an OAuth token refresh, a DID/PDS resolution, the
 * publication lookup, the createRecord. Five is what fits beside the rest with
 * room to spare. Anything over the cap waits for the next tick, and the pass
 * SAYS SO in its result and its log line — a silent cap reads as "handled
 * everything", which is the same lie as a silent failure.
 */
export const MAX_PUBLISHES_PER_TICK = 5;

/**
 * Attempts before a post is failed for good.
 *
 * Three hours of a PDS being unreachable is no longer transient, and an hourly
 * retry that never gives up is how a writer ends up with a row that has been
 * "pending" for a week. Failing tells them, which is the outcome they can act
 * on.
 */
export const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * How long a claim is honoured before the row is considered abandoned.
 *
 * A tick that is killed mid-publish (isolate eviction, an exceeded budget)
 * leaves `claimed_at` set with nobody working on it. Without this the row is
 * stranded forever — the silent never-published failure, arrived at by a
 * different road. Two hours is two ticks: long enough that a slow-but-alive
 * publish is never yanked out from under itself, short enough that the writer's
 * post is only ever late, not lost. Attempts are already counted, so a released
 * row cannot loop.
 */
export const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

/** A writer can only have as many pending schedules as they have drafts, so the
 * drafts cap bounds the manager's list already; this is the same guardrail
 * ~/lib/rights-store applies to its reads — a bound on a response, not a
 * quota. */
export const MAX_SCHEDULES_PER_WRITER = 100;

/** How long a published row is kept before pruning. Well past any retry
 * window, so a row can never be pruned while a tick could still act on it,
 * and long enough to answer "did last week's post actually go out?". */
export const PUBLISHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ScheduledStatus = "pending" | "published" | "failed";

/** One row as the writer's own surfaces read it. */
export type ScheduledRow = {
  id: string;
  draftId: string;
  dueAt: Date;
  status: ScheduledStatus;
  attempts: number;
  lastError: string | null;
};

/** A due row as the cron reads it — identity only, no content. */
export type DuePost = { id: string; did: string; draftId: string };

/**
 * Posts due to publish: pending, unclaimed, and past their time. Oldest first,
 * so a backlog drains in the order the writer scheduled it rather than in
 * whatever order the index happens to hand back.
 *
 * A row whose claim has gone stale is picked up here too, rather than in a
 * separate sweep: `releaseStaleClaims` clears the lease earlier in the same
 * tick, which keeps "who is allowed to work on this row" a single question with
 * a single answer.
 *
 * NOT DID-SCOPED — the documented exception at the top of this file.
 */
export function selectDuePosts(
  db: DrizzleD1,
  now: Date,
  limit: number = MAX_PUBLISHES_PER_TICK,
) {
  return db
    .select({
      id: scheduledPosts.id,
      did: scheduledPosts.did,
      draftId: scheduledPosts.draftId,
    })
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.status, "pending"),
        isNull(scheduledPosts.claimedAt),
        lte(scheduledPosts.dueAt, now),
      ),
    )
    .orderBy(asc(scheduledPosts.dueAt), asc(scheduledPosts.id))
    .limit(limit);
}

/**
 * Take the lease on one due row. THE ATOMIC STEP: the UPDATE only matches a row
 * that is still pending and still unclaimed, so of two ticks racing the same
 * row exactly one gets a row back from RETURNING and the other gets nothing and
 * moves on. Callers MUST NOT touch a row they did not win.
 *
 * The attempt is counted here, not after the publish, and the incremented value
 * comes back with the claim: an attempt that dies without reporting anything
 * still spent one, which is what stops a crash-loop from retrying forever.
 *
 * WHAT THIS CLOSES: cron versus cron — two overlapping ticks, a retried tick,
 * two isolates.
 *
 * WHAT IT DOES NOT CLOSE, and cannot: cron versus a live request. Every PDS
 * write funnels through /api/publish precisely because two concurrent token
 * refreshes for one DID can race, and the loser's refresh token is already
 * spent — the reason the official client is unusable here at all. A cron
 * publishing at 09:00 while the writer is saving a post at 09:00 is a second
 * writer of that session, and no row-level claim in OUR database can serialize
 * a refresh happening in THEIRS. The window is narrow (a publish holds a
 * session for a few hundred ms, on the hour, for writers who scheduled
 * something) and the cost when it is lost is a session the writer signs into
 * again — not lost words, and not a published-twice post. It is narrowed, it is
 * not gone, and the next person to read this should not think it was missed.
 */
export function claimDuePost(db: DrizzleD1, id: string, now: Date) {
  return db
    .update(scheduledPosts)
    .set({
      claimedAt: now,
      attempts: sql`${scheduledPosts.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledPosts.id, id),
        eq(scheduledPosts.status, "pending"),
        isNull(scheduledPosts.claimedAt),
      ),
    )
    .returning({ id: scheduledPosts.id, attempts: scheduledPosts.attempts });
}

/** The post went out: terminal, with the rkey it landed under. The lease is
 * cleared and the status is what stops any later tick from publishing it
 * again. */
export function markPublished(
  db: DrizzleD1,
  id: string,
  publishedRkey: string,
  now: Date,
) {
  return db
    .update(scheduledPosts)
    .set({
      status: "published",
      publishedRkey,
      claimedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(scheduledPosts.id, id))
    .returning({ id: scheduledPosts.id });
}

/** It failed for good: terminal, with the reason the writer reads in the posts
 * manager. Never a stack trace, never a bare status code. */
export function markFailed(
  db: DrizzleD1,
  id: string,
  reason: string,
  now: Date,
) {
  return db
    .update(scheduledPosts)
    .set({
      status: "failed",
      claimedAt: null,
      lastError: reason,
      updatedAt: now,
    })
    .where(eq(scheduledPosts.id, id))
    .returning({ id: scheduledPosts.id });
}

/** It failed in a way worth trying again: the lease goes back, the row stays
 * pending for the next tick, and the reason is recorded anyway — a writer
 * watching a post that is late deserves to see why it is late. */
export function releaseForRetry(
  db: DrizzleD1,
  id: string,
  reason: string,
  now: Date,
) {
  return db
    .update(scheduledPosts)
    .set({ claimedAt: null, lastError: reason, updatedAt: now })
    .where(eq(scheduledPosts.id, id))
    .returning({ id: scheduledPosts.id });
}

/** Hand back leases nobody is holding any more (see STALE_CLAIM_MS). One
 * indexed UPDATE at the top of the tick. */
export function releaseStaleClaims(db: DrizzleD1, before: Date, now: Date) {
  return db
    .update(scheduledPosts)
    .set({ claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(scheduledPosts.status, "pending"),
        lt(scheduledPosts.claimedAt, before),
      ),
    )
    .returning({ id: scheduledPosts.id });
}

/** Drop published rows past their retention window, so the table stays the
 * size of the work in front of it. */
export function prunePublished(db: DrizzleD1, before: Date) {
  return db
    .delete(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.status, "published"),
        lt(scheduledPosts.updatedAt, before),
      ),
    );
}

// ---------------------------------------------------------------------------
// Writer-facing queries. Every one pairs its keys with the session DID.
// ---------------------------------------------------------------------------

/**
 * Schedule a draft, or move one already scheduled — ONE statement, because
 * "schedule" and "reschedule" are the same intent to a writer and two
 * statements would leave a window where a double-submit publishes twice.
 *
 * The upsert targets the partial unique index on (did, draft_id) WHERE status =
 * 'pending' (see ~/db/schema): a draft can have one pending schedule and any
 * number of finished ones, so re-scheduling a draft that already failed inserts
 * cleanly instead of colliding with its history. A reschedule also resets
 * `attempts` and `last_error` — the writer picked a new time, so the new time
 * gets its own full budget of tries rather than inheriting a spent one.
 */
export function upsertSchedule(
  db: DrizzleD1,
  row: { id: string; did: string; draftId: string; dueAt: Date },
  now: Date = new Date(),
) {
  return db
    .insert(scheduledPosts)
    .values({ ...row, status: "pending", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [scheduledPosts.did, scheduledPosts.draftId],
      targetWhere: eq(scheduledPosts.status, "pending"),
      set: {
        dueAt: row.dueAt,
        attempts: 0,
        lastError: null,
        claimedAt: null,
        updatedAt: now,
      },
    })
    .returning({ id: scheduledPosts.id, dueAt: scheduledPosts.dueAt });
}

/** This writer's pending schedule for one draft — what the editor shows when a
 * scheduled draft is reopened. */
export function selectPendingScheduleForDraft(
  db: DrizzleD1,
  did: string,
  draftId: string,
) {
  return db
    .select({
      id: scheduledPosts.id,
      dueAt: scheduledPosts.dueAt,
      attempts: scheduledPosts.attempts,
      lastError: scheduledPosts.lastError,
    })
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.did, did),
        eq(scheduledPosts.draftId, draftId),
        eq(scheduledPosts.status, "pending"),
      ),
    )
    .limit(1);
}

/**
 * The Scheduled tab: this writer's pending and failed rows, soonest first, with
 * the draft's title joined on so the list can name the piece. Left join, and
 * the DID appears on BOTH sides of it — the schedule's and the draft's — so the
 * join can never widen the ownership rule the WHERE establishes.
 *
 * Published rows are deliberately absent: the post itself is what "it went out"
 * looks like, and it is on the Published tab. What belongs here is work that
 * has not happened yet and work that went wrong.
 */
export function selectWriterSchedule(db: DrizzleD1, did: string) {
  return db
    .select({
      id: scheduledPosts.id,
      draftId: scheduledPosts.draftId,
      dueAt: scheduledPosts.dueAt,
      status: scheduledPosts.status,
      attempts: scheduledPosts.attempts,
      lastError: scheduledPosts.lastError,
      title: drafts.title,
    })
    .from(scheduledPosts)
    .leftJoin(
      drafts,
      and(
        eq(drafts.id, scheduledPosts.draftId),
        eq(drafts.did, scheduledPosts.did),
      ),
    )
    .where(
      and(
        eq(scheduledPosts.did, did),
        or(
          eq(scheduledPosts.status, "pending"),
          eq(scheduledPosts.status, "failed"),
        ),
      ),
    )
    .orderBy(asc(scheduledPosts.dueAt), asc(scheduledPosts.id))
    .limit(MAX_SCHEDULES_PER_WRITER);
}

/**
 * Cancel: the row is DELETED, not marked. Nothing is due, nothing shows in the
 * manager, and there is no fourth status to reason about — a writer who
 * cancelled a schedule is a writer who has a draft, which is exactly the state
 * they were in before.
 *
 * Empty result = no such row, or not theirs (deliberately the same answer,
 * as everywhere else in this codebase).
 */
export function cancelSchedule(db: DrizzleD1, did: string, id: string) {
  return db
    .delete(scheduledPosts)
    .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.did, did)))
    .returning({ id: scheduledPosts.id, draftId: scheduledPosts.draftId });
}

/** This writer's schedule for one draft whatever its status — the question
 * "is there one, and is a tick working on it right now?". */
export function selectScheduleForDraft(
  db: DrizzleD1,
  did: string,
  draftId: string,
) {
  return db
    .select({
      id: scheduledPosts.id,
      status: scheduledPosts.status,
      dueAt: scheduledPosts.dueAt,
      claimedAt: scheduledPosts.claimedAt,
    })
    .from(scheduledPosts)
    .where(
      and(eq(scheduledPosts.did, did), eq(scheduledPosts.draftId, draftId)),
    )
    .limit(1);
}

/**
 * Take a draft's schedule OUT of the queue, but only if no tick is working on
 * it — the request-side counterpart of `claimDuePost`, and the reason "publish
 * now" cannot publish a post the cron is publishing at that exact moment.
 *
 * A returned row means the caller owns the publish: a row that no longer exists
 * cannot be claimed by any tick afterwards. No returned row means either there
 * was no schedule (a plain draft — fine) or a tick holds the lease, and the
 * caller must ask which before writing anything to the writer's repo. That is
 * the whole double-publish guard on the interactive path, and it is one
 * statement precisely so there is no window inside it.
 */
export function deleteUnclaimedSchedulesForDraft(
  db: DrizzleD1,
  did: string,
  draftId: string,
) {
  return db
    .delete(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.did, did),
        eq(scheduledPosts.draftId, draftId),
        isNull(scheduledPosts.claimedAt),
      ),
    )
    .returning({ id: scheduledPosts.id, status: scheduledPosts.status });
}

/**
 * Cancel by draft — what deleting a draft calls. A schedule whose draft is gone
 * has nothing to publish, and leaving it behind would fail loudly later for
 * something the writer did on purpose. Deleting the draft IS cancelling the
 * schedule, so it happens in the same breath.
 */
export function deleteSchedulesForDraft(
  db: DrizzleD1,
  did: string,
  draftId: string,
) {
  return db
    .delete(scheduledPosts)
    .where(
      and(eq(scheduledPosts.did, did), eq(scheduledPosts.draftId, draftId)),
    )
    .returning({ id: scheduledPosts.id });
}

// ---------------------------------------------------------------------------
// The per-tick pass.
// ---------------------------------------------------------------------------

/** The narrow slice of storage the pass needs. One real implementation
 * (`d1ScheduledPostStore`); tests hand it a plain object. */
export type ScheduledPostStore = {
  /** Rows past due, unclaimed, capped. */
  due(now: Date, limit: number): Promise<DuePost[]>;
  /** Take the lease. Resolves to the new attempt count, or null if another
   * caller already had it. */
  claim(id: string, now: Date): Promise<number | null>;
  published(id: string, rkey: string, now: Date): Promise<unknown>;
  failed(id: string, reason: string, now: Date): Promise<unknown>;
  retry(id: string, reason: string, now: Date): Promise<unknown>;
  releaseStale(before: Date, now: Date): Promise<Array<{ id: string }>>;
  prune(before: Date): Promise<unknown>;
};

export function d1ScheduledPostStore(db: DrizzleD1): ScheduledPostStore {
  return {
    due(now, limit) {
      return selectDuePosts(db, now, limit);
    },
    async claim(id, now) {
      const [row] = await claimDuePost(db, id, now);
      return row ? row.attempts : null;
    },
    published(id, rkey, now) {
      return markPublished(db, id, rkey, now);
    },
    failed(id, reason, now) {
      return markFailed(db, id, reason, now);
    },
    retry(id, reason, now) {
      return releaseForRetry(db, id, reason, now);
    },
    releaseStale(before, now) {
      return releaseStaleClaims(db, before, now);
    },
    prune(before) {
      return prunePublished(db, before);
    },
  };
}

/**
 * What one publish attempt reports back.
 *
 * `retry` is the publisher's judgement about the FAILURE, not about the post:
 * a PDS that answered 502 is worth another hour, a revoked OAuth grant is not,
 * and only the publisher can tell those apart. `reason` is written into the row
 * and shown to the writer, so it is a sentence, not a code.
 */
export type PublishAttempt =
  | { ok: true; rkey: string }
  | { ok: false; retry: boolean; reason: string };

export type ScheduledPublisher = (post: DuePost) => Promise<PublishAttempt>;

export type SchedulePassResult = {
  /** Rows this tick claimed and worked on. */
  attempted: number;
  published: number;
  /** Failed for good — each one now carries a reason the writer can read. */
  failed: number;
  /** Left pending for the next tick. */
  retrying: number;
  /** Lost the claim race to another tick (cron-vs-cron, working as designed). */
  contended: number;
  /** Abandoned leases handed back at the top of the tick. */
  releasedStale: number;
  /** True when there were more due posts than the cap allowed. Reported, never
   * swallowed: the log line has to say a queue was left behind. */
  capped: boolean;
  pruned: boolean;
};

/**
 * The reason attached when an attempt throws instead of returning. A publisher
 * that throws is a bug in the publisher, not a verdict about the post, so the
 * row goes back for another tick rather than being failed on it.
 */
const THREW_REASON =
  "Publishing hit an unexpected error on our side. Goldroad will try again within the hour.";

/**
 * One tick of scheduled publishing.
 *
 * Never throws — a cron that throws is simply retried by the platform, and a
 * retry of a half-finished pass is only safe because of the claim; logging and
 * moving on keeps one writer's broken row from costing every other writer their
 * scheduled post. Each post is attempted in sequence, not in parallel: the
 * shared budget is the constraint, and five sequential publishes with a
 * bounded cap is the cheap, predictable shape.
 */
export async function runScheduledPublishPass(opts: {
  store: ScheduledPostStore;
  publish: ScheduledPublisher;
  now?: number;
  cap?: number;
}): Promise<SchedulePassResult> {
  const {
    store,
    publish,
    now: nowMs = Date.now(),
    cap = MAX_PUBLISHES_PER_TICK,
  } = opts;
  const now = new Date(nowMs);
  const result: SchedulePassResult = {
    attempted: 0,
    published: 0,
    failed: 0,
    retrying: 0,
    contended: 0,
    releasedStale: 0,
    capped: false,
    pruned: false,
  };

  // Abandoned leases first, so a row a dead tick was holding is eligible in
  // THIS pass rather than an hour later.
  try {
    const released = await store.releaseStale(
      new Date(nowMs - STALE_CLAIM_MS),
      now,
    );
    result.releasedStale = released.length;
    if (released.length > 0)
      console.warn(
        "scheduled posts: released abandoned claims",
        released.map((row) => row.id),
      );
  } catch (err) {
    console.error("scheduled posts: stale-claim release failed", err);
  }

  try {
    // One more than the cap, so "there is a queue behind this" is a fact we
    // read rather than a guess we make from a full page.
    const due = await store.due(now, cap + 1);
    result.capped = due.length > cap;
    for (const post of due.slice(0, cap)) {
      const attempts = await store.claim(post.id, now);
      // Another tick got there first. Not an error — this is the claim doing
      // exactly what it exists for.
      if (attempts === null) {
        result.contended++;
        continue;
      }
      result.attempted++;
      let attempt: PublishAttempt;
      try {
        attempt = await publish(post);
      } catch (err) {
        console.error("scheduled publish threw", post.id, err);
        attempt = { ok: false, retry: true, reason: THREW_REASON };
      }
      if (attempt.ok) {
        await store.published(post.id, attempt.rkey, now);
        result.published++;
        continue;
      }
      // The ceiling is checked against the count the claim just returned, so
      // it is the same number in every isolate that could be looking at it.
      const exhausted = attempts >= MAX_PUBLISH_ATTEMPTS;
      if (attempt.retry && !exhausted) {
        await store.retry(post.id, attempt.reason, now);
        result.retrying++;
        continue;
      }
      await store.failed(
        post.id,
        exhausted && attempt.retry
          ? `${attempt.reason} Goldroad stopped trying after ${MAX_PUBLISH_ATTEMPTS} attempts.`
          : attempt.reason,
        now,
      );
      result.failed++;
    }
    if (result.capped)
      console.log(
        `scheduled posts: published up to the per-tick cap of ${cap}; more are due and will go out next tick`,
      );
  } catch (err) {
    console.error("scheduled publish pass failed", err);
  }

  // Independent of the publishing above: a bad hour is no reason to let
  // finished rows accumulate.
  try {
    await store.prune(new Date(nowMs - PUBLISHED_RETENTION_MS));
    result.pruned = true;
  } catch (err) {
    console.error("scheduled posts prune failed", err);
  }
  return result;
}
