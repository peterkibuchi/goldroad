// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  cancelSchedule,
  claimDuePost,
  deleteSchedulesForDraft,
  MAX_PUBLISHES_PER_TICK,
  markFailed,
  markPublished,
  prunePublished,
  releaseForRetry,
  releaseStaleClaims,
  selectDuePosts,
  selectPendingScheduleForDraft,
  selectWriterSchedule,
  upsertSchedule,
} from "../lib/scheduled-posts";

/**
 * The SQL, pinned via .toSQL() without a live D1 — the same way the rest of
 * this codebase verifies its queries (drafts.test.ts, rights-store.test.ts,
 * scheduled.test.ts).
 *
 * Two things here are load-bearing beyond "the query runs":
 *
 *  1. THE CLAIM'S WHERE CLAUSE. It is the only thing standing between two ticks
 *     and a post published twice. If `status = 'pending' AND claimed_at IS
 *     NULL` ever falls out of that UPDATE, both callers get a row back and both
 *     publish. Nothing else in the system catches that.
 *  2. THE DID ON EVERY WRITER-FACING QUERY. One query here is deliberately
 *     cross-writer (the cron's due lookup) and that asymmetry is exactly why
 *     the rest are pinned individually rather than trusted.
 */
// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);
const DID = "did:plc:fake2222222222writer2222";
const OTHER_DID = "did:plc:fakeforeign22222writer22";
const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const ROW_ID = "99999999-8888-4777-8666-555555555555";
const NOW = new Date("2026-08-04T09:00:00.000Z");

function expectDidBound(sql: string, params: unknown[]) {
  expect(sql.toLowerCase()).toContain("where");
  expect(sql).toContain('"did"');
  expect(params).toContain(DID);
  expect(params).not.toContain(OTHER_DID);
}

describe("claimDuePost — the atomic step", () => {
  it("only matches a row that is still pending AND still unclaimed", () => {
    const { sql, params } = claimDuePost(db, ROW_ID, NOW).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('update "scheduled_posts"');
    expect(lower).toContain("where");
    // The three conditions, together: this id, pending, unclaimed.
    expect(sql).toContain('"id" = ?');
    expect(sql).toContain('"status" = ?');
    expect(lower).toContain('"claimed_at" is null');
    expect(params).toContain(ROW_ID);
    expect(params).toContain("pending");
  });

  it("counts the attempt in the same statement that takes the lease", () => {
    // An attempt that dies without reporting must still have been spent —
    // otherwise a crash-loop retries forever. Incrementing anywhere but here
    // leaves a window where it isn't counted.
    const { sql } = claimDuePost(db, ROW_ID, NOW).toSQL();
    expect(sql).toContain('"attempts" = "scheduled_posts"."attempts" + 1');
    expect(sql).toContain('"claimed_at" = ?');
  });

  it("returns the row it won — the caller's only proof it won", () => {
    const { sql } = claimDuePost(db, ROW_ID, NOW).toSQL();
    expect(sql.toLowerCase()).toContain("returning");
    expect(sql).toContain('"attempts"');
  });
});

describe("selectDuePosts — the cron's lookup", () => {
  it("asks only for pending, unclaimed, past-due rows, oldest first", () => {
    const { sql, params } = selectDuePosts(db, NOW).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('from "scheduled_posts"');
    expect(sql).toContain('"status" = ?');
    expect(lower).toContain('"claimed_at" is null');
    expect(sql).toContain('"due_at" <= ?');
    expect(lower).toContain('order by "scheduled_posts"."due_at"');
    expect(params).toContain("pending");
    expect(params).toContain(NOW.getTime());
  });

  it("carries a limit, and defaults it to the per-tick cap", () => {
    const { sql, params } = selectDuePosts(db, NOW).toSQL();
    expect(sql.toLowerCase()).toContain("limit");
    expect(params).toContain(MAX_PUBLISHES_PER_TICK);
  });

  it("returns identity only — no draft content crosses this query", () => {
    // The cron reads the draft itself in a second, DID-SCOPED query. Selecting
    // content here would be the one place a writer's words travel on a query
    // that isn't bound to their DID.
    const { sql } = selectDuePosts(db, NOW).toSQL();
    expect(sql).toContain('"did"');
    expect(sql).toContain('"draft_id"');
    expect(sql).not.toContain('"content"');
    expect(sql).not.toContain('"markdown"');
  });
});

describe("the writer-facing queries are bound to the writer", () => {
  it("selectWriterSchedule filters by DID and hides finished rows", () => {
    const { sql, params } = selectWriterSchedule(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain("pending");
    expect(params).toContain("failed");
    expect(params).not.toContain("published");
  });

  it("selectWriterSchedule's join cannot widen ownership", () => {
    // The DID appears on BOTH sides of the join. A join on draft id alone
    // would attach another writer's draft title to this writer's row.
    const { sql } = selectWriterSchedule(db, DID).toSQL();
    expect(sql.toLowerCase()).toContain('left join "drafts"');
    expect(sql).toContain('"drafts"."did" = "scheduled_posts"."did"');
    expect(sql).toContain('"drafts"."id" = "scheduled_posts"."draft_id"');
  });

  it("selectPendingScheduleForDraft pairs the draft id with the DID", () => {
    const { sql, params } = selectPendingScheduleForDraft(
      db,
      DID,
      DRAFT_ID,
    ).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(DRAFT_ID);
    expect(params).toContain("pending");
  });

  it("cancelSchedule deletes by id AND DID", () => {
    const { sql, params } = cancelSchedule(db, DID, ROW_ID).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "scheduled_posts"');
    expectDidBound(sql, params);
    expect(params).toContain(ROW_ID);
    // Empty result must be distinguishable from "it worked".
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteSchedulesForDraft deletes by draft AND DID", () => {
    const { sql, params } = deleteSchedulesForDraft(db, DID, DRAFT_ID).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "scheduled_posts"');
    expectDidBound(sql, params);
    expect(params).toContain(DRAFT_ID);
  });

  it("upsertSchedule writes the writer's DID and reschedules in one statement", () => {
    const { sql, params } = upsertSchedule(
      db,
      { id: ROW_ID, did: DID, draftId: DRAFT_ID, dueAt: NOW },
      NOW,
    ).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('insert into "scheduled_posts"');
    expect(lower).toContain("on conflict");
    expect(params).toContain(DID);
    expect(params).toContain(DRAFT_ID);
    // The conflict target is the PARTIAL index — target columns AND the
    // index's own WHERE, so a finished row for the same draft cannot block a
    // fresh schedule (SQLite matches a partial index only when both agree).
    expect(sql).toContain(
      'on conflict ("scheduled_posts"."did", "scheduled_posts"."draft_id") where "scheduled_posts"."status" = ?',
    );
    // A new time gets a full budget of attempts, not the spent one, and no
    // inherited lease or stale error message.
    expect(sql).toContain('do update set "due_at" = ?, "attempts" = ?');
    expect(sql).toContain('"last_error" = ?');
    expect(sql).toContain('"claimed_at" = ?');
    expect(params).toContain(0);
  });
});

describe("the terminal writes", () => {
  it("markPublished clears the lease and records the rkey", () => {
    const { sql, params } = markPublished(
      db,
      ROW_ID,
      "3lyk73wxnok2f",
      NOW,
    ).toSQL();
    expect(params).toContain("published");
    expect(params).toContain("3lyk73wxnok2f");
    // The lease is handed back as a bound null, not left set: a terminal row
    // holding a claim would be swept by the stale-claim release forever.
    expect(sql).toContain('"claimed_at" = ?');
    expect(params).toContain(null);
  });

  it("markFailed stores the writer-readable reason and clears the lease", () => {
    const reason = "Your data server refused the post.";
    const { sql, params } = markFailed(db, ROW_ID, reason, NOW).toSQL();
    expect(params).toContain("failed");
    expect(params).toContain(reason);
    expect(sql).toContain('"claimed_at" = ?');
    expect(params).toContain(null);
  });

  it("releaseForRetry keeps the row pending but hands the lease back", () => {
    const { sql, params } = releaseForRetry(
      db,
      ROW_ID,
      "PDS was down.",
      NOW,
    ).toSQL();
    expect(sql).toContain('"claimed_at" = ?');
    expect(params).toContain(null);
    expect(params).toContain("PDS was down.");
    // Crucially NOT terminal — the next tick has to be able to see it.
    expect(params).not.toContain("failed");
    expect(sql).not.toContain('"status" = ?');
  });

  it("releaseStaleClaims only touches pending rows with an expired lease", () => {
    const before = new Date(NOW.getTime() - 7_200_000);
    const { sql, params } = releaseStaleClaims(db, before, NOW).toSQL();
    expect(sql).toContain('"claimed_at" < ?');
    expect(params).toContain(before.getTime());
    expect(params).toContain("pending");
  });

  it("prunePublished only ever deletes finished rows", () => {
    const before = new Date(NOW.getTime() - 1000);
    const { sql, params } = prunePublished(db, before).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "scheduled_posts"');
    expect(params).toContain("published");
    expect(sql).toContain('"updated_at" < ?');
  });
});
