/**
 * The writer's announce preference, and the budget that bounds what the auto
 * path may spend on their behalf — the D1 half of ~/lib/announce.
 *
 * Same contract as ~/lib/drafts and ~/lib/import-store: every query pairs its
 * rows with the owner's DID, functions return drizzle query builders (awaitable,
 * verifiable via `.toSQL()` without a live D1), and nothing here decides
 * anything — the policy is pure and lives next to the record shaping.
 *
 * ABSENT MEANS DEFAULT, EVERYWHERE. A writer who has never opened the setting
 * has no row, and `announceDefaultFor` reads that absence as "on" — the same
 * answer the column's own default gives. Two places have to agree on that and
 * both are in this file, because the alternative is a page that renders the
 * toggle off while the publish path treats it as on.
 */
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { writerPrefs } from "~/db/schema";
import {
  AUTO_ANNOUNCE_WINDOW_MS,
  MAX_AUTO_ANNOUNCES_PER_HOUR,
} from "~/lib/announce";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** One writer's preferences row, or nothing. */
export function selectWriterPrefs(db: DrizzleD1, did: string) {
  return db
    .select({
      autoAnnounce: writerPrefs.autoAnnounce,
      autoCount: writerPrefs.autoCount,
      autoWindowAt: writerPrefs.autoWindowAt,
    })
    .from(writerPrefs)
    .where(eq(writerPrefs.did, did))
    .limit(1);
}

/**
 * Does this writer announce new posts by default? THE ONE READING of an absent
 * row: no row means the writer has never had an opinion, and the product's
 * default is to reach the followers they already have.
 *
 * A row we could not READ is a different thing, and callers treat it the same
 * way on purpose: the setting is pre-filled into a checkbox the writer can see
 * and change before pressing anything, so a flaked read costs them one glance,
 * not a surprise post.
 */
export function announceDefaultFor(
  row: { autoAnnounce: boolean } | undefined,
): boolean {
  return row ? row.autoAnnounce : true;
}

/**
 * Save the account-level setting. Upsert, because the row may not exist yet and
 * "off" is the first thing a writer is likely to want to store.
 *
 * The budget columns are deliberately left alone: changing a preference is not
 * an announce, and resetting the counter here would make the toggle a way to
 * refill the budget.
 */
export function setAutoAnnounce(
  db: DrizzleD1,
  did: string,
  autoAnnounce: boolean,
  now: Date = new Date(),
) {
  return db
    .insert(writerPrefs)
    .values({ did, autoAnnounce, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: writerPrefs.did,
      set: { autoAnnounce, updatedAt: now },
    })
    .returning({ autoAnnounce: writerPrefs.autoAnnounce });
}

/**
 * Spend one slot of the writer's hourly auto-announce budget and report how
 * many they have now spent. ONE STATEMENT, which is the point: a read followed
 * by a write has a window in it, and two isolates publishing for the same writer
 * in the same second would both read "0 spent".
 *
 * The window is rolling by reset rather than by sliding count: the CASE opens a
 * fresh window (count 1) when the stored one is older than an hour, and
 * otherwise adds to the one in progress. A sliding window would need the
 * timestamp of every announce, which is a ledger table and a prune job to hold
 * a number that is only ever compared against five.
 *
 * IT COUNTS EVEN WHEN IT REFUSES. An attempt that lands over the cap still
 * increments, so a writer at the ceiling keeps climbing until the window rolls.
 * That is deliberate — the alternative is a second CASE arm to hold a number
 * whose only meaning is "already too many" — and it is why the counter is not
 * an announce count and must never be reported as one.
 */
export function consumeAutoAnnounceBudget(
  db: DrizzleD1,
  did: string,
  now: Date = new Date(),
) {
  const nowMs = now.getTime();
  const windowStart = nowMs - AUTO_ANNOUNCE_WINDOW_MS;
  // Raw ms, not Dates: these are interpolated into a CASE expression rather
  // than bound through a typed column, and ms IS the stored representation of a
  // timestamp_ms column.
  const stale = sql`(${writerPrefs.autoWindowAt} is null or ${writerPrefs.autoWindowAt} <= ${windowStart})`;
  return db
    .insert(writerPrefs)
    .values({
      did,
      // The row is being created BY an announce, so the writer's setting is on
      // — nothing else could have got us here.
      autoAnnounce: true,
      autoCount: 1,
      autoWindowAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: writerPrefs.did,
      set: {
        // Bare column references inside ON CONFLICT DO UPDATE are the EXISTING
        // row's values in SQLite (`excluded.` would be the new ones), which is
        // what makes this an increment.
        autoCount: sql`case when ${stale} then 1 else ${writerPrefs.autoCount} + 1 end`,
        autoWindowAt: sql`case when ${stale} then ${nowMs} else ${writerPrefs.autoWindowAt} end`,
        updatedAt: now,
      },
    })
    .returning({ spent: writerPrefs.autoCount });
}

/** Is a spend within the cap? Pure, so the caller can log the number it got
 * back either way. */
export function withinAutoAnnounceBudget(spent: number): boolean {
  return spent <= MAX_AUTO_ANNOUNCES_PER_HOUR;
}
