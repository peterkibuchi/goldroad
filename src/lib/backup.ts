/**
 * Backup monitoring: is there an off-platform copy of D1, and is it recent
 * enough to be worth having?
 *
 * WHY THIS IS A MONITOR AND NOT AN EXPORTER — the important part.
 *
 * D1 ships Time Travel on every plan: a 30-day point-in-time restore, always
 * on, nothing to configure. It already covers the failure modes that actually
 * happen to a database this size — a migration that drops the wrong column, a
 * DELETE without a WHERE, a bad backfill. `wrangler d1 time-travel restore`
 * fixes all of those with no machinery on our side, so a hand-rolled row
 * exporter would duplicate it for no additional safety.
 *
 * What Time Travel does NOT cover is narrow but fatal:
 *   • It lives INSIDE the database. Delete the database (or lose the account)
 *     and the 30 days of history go with it.
 *   • It restores in place. There is no way to get the bytes out.
 *   • Nothing older than 30 days exists, at all.
 *
 * Closing that needs a real export, stored elsewhere. The export cannot run in
 * this Worker: D1's export is an account-scoped REST operation, polled to
 * completion and then downloaded from a signed URL. It needs an account API
 * token — a far bigger blast radius than the database it protects — and it
 * takes far longer than a cron invocation's CPU budget allows. So it runs in
 * CI, where that token already exists to deploy, and where the artifact lands
 * off-platform for free.
 *
 * That split leaves exactly one thing unaccounted for, and it is the way
 * backups usually fail: a job that has quietly stopped running is
 * indistinguishable from one that is working, and nobody finds out until the
 * restore. So CI stamps a `backup_runs` row only after a verified, encrypted,
 * uploaded export, and this module — folded into the hourly cron that already
 * has an alerting path — notices when the newest row goes stale.
 *
 * SHAPE. Everything here is a drizzle query builder (verifiable via `.toSQL()`
 * without a live D1), a pure function, or a pass over an injectable store —
 * the same shape as ~/lib/follower-snapshots.
 */
import { desc, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { backupRuns } from "~/db/schema";

type DrizzleD1 = ReturnType<typeof drizzle>;

const MS_PER_HOUR = 3_600_000;

/** How often CI is scheduled to export. Documentation, not enforcement — the
 * schedule itself lives in .github/workflows/backup.yml. */
export const BACKUP_INTERVAL_HOURS = 24;

/** Age at which a backup stops counting as current. Two intervals, not one, on
 * purpose: a single skipped nightly run is a blip (a runner outage, a queued
 * job), and paging on a blip is how alerts get muted. Two consecutive misses
 * is a pattern worth waking up for. */
export const BACKUP_MAX_AGE_HOURS = 2 * BACKUP_INTERVAL_HOURS;

/** A dump below this is broken, not small. The schema statements alone are
 * comfortably over a kilobyte, so this floor catches the export that reports
 * success and writes almost nothing — the failure an "it ran!" heartbeat would
 * otherwise happily confirm. */
export const MIN_PLAUSIBLE_BACKUP_BYTES = 1024;

/** Heartbeats are kept for a season, then pruned. One row a day means the table
 * tops out near 90 rows; the history exists to answer "when did this start
 * failing", which does not need more than that. */
export const BACKUP_RUN_RETENTION_DAYS = 90;

/** The newest backup heartbeat. `at` is unix-ms. */
export type BackupRun = { at: number; bytes: number };

/** Newest heartbeat first, one row — the only read this table has. */
export function selectLatestBackupRun(db: DrizzleD1) {
  return db
    .select({ at: backupRuns.at, bytes: backupRuns.bytes })
    .from(backupRuns)
    .orderBy(desc(backupRuns.at))
    .limit(1);
}

/** Drop heartbeats past the retention window. Runs in the same pass that reads,
 * so the table cannot grow without a matching prune. */
export function pruneBackupRuns(db: DrizzleD1, before: Date) {
  return db.delete(backupRuns).where(lt(backupRuns.at, before));
}

/** A whole, non-negative, in-range byte count. Read back out of the database,
 * so it is checked rather than trusted: a null or garbage size must read as
 * "cannot verify this backup", never as a passing check. */
function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Is the newest backup good enough — pure, so every branch is testable without
 * a database. Returns human-readable failure strings for the cron's existing
 * alert path; empty means healthy.
 *
 * Three distinct ways a backup can be worthless, all checked:
 *  1. It does not exist. Never backed up, or the table was just created.
 *  2. It is too old — the job stopped, and nobody was told.
 *  3. It is fresh but far too small to be a real dump.
 *
 * A heartbeat dated in the FUTURE is a failure rather than very fresh. Clock
 * skew or a malformed stamp would otherwise pin this check to "healthy"
 * permanently, which is the one outcome worse than a false alarm.
 */
export function checkBackupFreshness(input: {
  latest: BackupRun | null;
  now?: number;
  maxAgeHours?: number;
}): string[] {
  const { latest } = input;
  const now = input.now ?? Date.now();
  const maxAgeHours = input.maxAgeHours ?? BACKUP_MAX_AGE_HOURS;

  if (!latest) return ["no off-platform backup has ever been recorded"];
  if (!Number.isFinite(latest.at))
    return [`backup heartbeat has an unreadable timestamp (${latest.at})`];

  const failures: string[] = [];
  const ageHours = (now - latest.at) / MS_PER_HOUR;

  if (ageHours < 0) {
    const at = new Date(latest.at).toISOString();
    failures.push(`newest backup is dated in the future (${at})`);
  } else if (ageHours > maxAgeHours) {
    const age = Math.floor(ageHours);
    failures.push(`newest backup is ${age}h old (max ${maxAgeHours}h)`);
  }

  if (!isByteCount(latest.bytes)) {
    failures.push(`backup size is unreadable (${latest.bytes})`);
  } else if (latest.bytes < MIN_PLAUSIBLE_BACKUP_BYTES) {
    const min = MIN_PLAUSIBLE_BACKUP_BYTES;
    failures.push(`backup is only ${latest.bytes} bytes (min ${min})`);
  }

  return failures;
}

/** The slice of storage the check needs. One real implementation
 * (`d1BackupStore`); tests hand it a plain object. */
export type BackupStore = {
  latest(): Promise<BackupRun | null>;
  prune(before: Date): Promise<unknown>;
};

export function d1BackupStore(db: DrizzleD1): BackupStore {
  return {
    async latest() {
      const [row] = await selectLatestBackupRun(db);
      if (!row) return null;
      // `at` comes back as a Date (drizzle's timestamp_ms mode); the pure check
      // works in unix-ms so it never has to care which it was given.
      return { at: Number(row.at), bytes: row.bytes };
    },
    prune(before) {
      return pruneBackupRuns(db, before);
    },
  };
}

export type BackupCheckResult = {
  failures: string[];
  pruned: boolean;
};

/**
 * The cron's backup pass: read the newest heartbeat, judge it, prune old ones.
 *
 * Never throws — a cron that throws is just retried, and this is the cheap
 * always-on backstop, not the thing being protected. A failed READ is reported
 * as a failure rather than swallowed: the likeliest cause is the migration
 * never having been applied, which is precisely the state where "no news" must
 * not read as good news.
 */
export async function runBackupCheck(opts: {
  store: BackupStore;
  now?: number;
}): Promise<BackupCheckResult> {
  const { store } = opts;
  const now = opts.now ?? Date.now();
  const result: BackupCheckResult = { failures: [], pruned: false };

  try {
    const latest = await store.latest();
    result.failures = checkBackupFreshness({ latest, now });
  } catch (err) {
    console.error("backup heartbeat read failed", err);
    result.failures = [`cannot read the backup heartbeat: ${String(err)}`];
  }

  // Independent of the check: a bad read is no reason to let the table grow.
  try {
    const retentionMs = BACKUP_RUN_RETENTION_DAYS * 24 * MS_PER_HOUR;
    await store.prune(new Date(now - retentionMs));
    result.pruned = true;
  } catch (err) {
    console.error("backup heartbeat prune failed", err);
  }

  return result;
}
