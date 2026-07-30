// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";

import {
  BACKUP_MAX_AGE_HOURS,
  type BackupStore,
  checkBackupFreshness,
  MIN_PLAUSIBLE_BACKUP_BYTES,
  pruneBackupRuns,
  runBackupCheck,
  selectLatestBackupRun,
} from "../lib/backup";

const HOUR = 3_600_000;
const NOW = 1_785_400_000_000;
const REAL_SIZE = 64 * 1024;

/** A healthy heartbeat: recent, and big enough to be a real dump. */
function goodRun(ageHours = 1): { at: number; bytes: number } {
  return { at: NOW - ageHours * HOUR, bytes: REAL_SIZE };
}

describe("checkBackupFreshness — the ways a backup is worthless", () => {
  it("passes a recent backup of plausible size", () => {
    expect(checkBackupFreshness({ latest: goodRun(), now: NOW })).toEqual([]);
  });

  it("flags a database that has never been backed up", () => {
    const failures = checkBackupFreshness({ latest: null, now: NOW });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      "no off-platform backup has ever been recorded",
    );
  });

  it("still passes at exactly the age limit", () => {
    // Inclusive on purpose: a job landing on its deadline is on time, and an
    // hourly cron will sit right on this edge.
    const at = NOW - BACKUP_MAX_AGE_HOURS * HOUR;
    const failures = checkBackupFreshness({
      latest: { at, bytes: REAL_SIZE },
      now: NOW,
    });
    expect(failures).toEqual([]);
  });

  it("flags a backup past the age limit", () => {
    const at = NOW - (BACKUP_MAX_AGE_HOURS + 1) * HOUR;
    const failures = checkBackupFreshness({
      latest: { at, bytes: REAL_SIZE },
      now: NOW,
    });
    expect(failures.some((f) => f.includes("old"))).toBe(true);
  });

  it("tolerates one missed nightly run, complains about two", () => {
    // Why the limit is two intervals, not one: paging on a single skipped run
    // is how an alert gets muted.
    const one = checkBackupFreshness({ latest: goodRun(25), now: NOW });
    const two = checkBackupFreshness({ latest: goodRun(49), now: NOW });
    expect(one).toEqual([]);
    expect(two).not.toEqual([]);
  });

  it("flags a fresh backup far too small to be a real dump", () => {
    // The failure an "it ran!" heartbeat would otherwise confirm as healthy.
    const bytes = MIN_PLAUSIBLE_BACKUP_BYTES - 1;
    const failures = checkBackupFreshness({
      latest: { at: NOW - HOUR, bytes },
      now: NOW,
    });
    expect(failures.some((f) => f.includes("bytes"))).toBe(true);
  });

  it("flags an empty dump", () => {
    const failures = checkBackupFreshness({
      latest: { at: NOW - HOUR, bytes: 0 },
      now: NOW,
    });
    expect(failures.some((f) => f.includes("bytes"))).toBe(true);
  });

  it("reports age AND size together when both are wrong", () => {
    const failures = checkBackupFreshness({
      latest: { at: NOW - 200 * HOUR, bytes: 4 },
      now: NOW,
    });
    expect(failures).toHaveLength(2);
  });

  it("treats a future-dated heartbeat as a failure, not as fresh", () => {
    // Clock skew or a malformed stamp would otherwise pin this check to
    // "healthy" forever — the one outcome worse than a false alarm.
    const failures = checkBackupFreshness({
      latest: { at: NOW + 48 * HOUR, bytes: REAL_SIZE },
      now: NOW,
    });
    expect(failures.some((f) => f.includes("future"))).toBe(true);
  });

  it("never reads a garbage size as a passing check", () => {
    const garbage = [null, undefined, Number.NaN, -1, 1.5, "64000"];
    for (const bytes of garbage) {
      const failures = checkBackupFreshness({
        // biome-ignore lint/suspicious/noExplicitAny: malformed on purpose
        latest: { at: NOW - HOUR, bytes } as any,
        now: NOW,
      });
      expect(failures.some((f) => f.includes("size"))).toBe(true);
    }
  });

  it("flags an unreadable timestamp instead of computing an age", () => {
    const failures = checkBackupFreshness({
      latest: { at: Number.NaN, bytes: REAL_SIZE },
      now: NOW,
    });
    expect(failures.some((f) => f.includes("unreadable"))).toBe(true);
  });
});

describe("the heartbeat queries", () => {
  // Build-only drizzle instance; .toSQL() never touches the (empty) client.
  // biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
  const db = drizzle({} as any);

  it("reads the newest heartbeat, and only one", () => {
    const { sql } = selectLatestBackupRun(db).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('from "backup_runs"');
    expect(lower).toContain("order by");
    expect(lower).toContain("desc");
    expect(lower).toContain("limit");
  });

  it("prunes strictly older than the cutoff", () => {
    const { sql, params } = pruneBackupRuns(db, new Date(NOW)).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "backup_runs"');
    expect(sql).toContain('"at"');
    expect(sql).toContain("<");
    expect(params).toContain(NOW);
  });
});

describe("runBackupCheck — never turns a bad read into good news", () => {
  function store(overrides: Partial<BackupStore> = {}): BackupStore {
    return {
      latest: async () => goodRun(),
      prune: async () => undefined,
      ...overrides,
    };
  }

  it("reports a healthy backup and prunes in the same pass", async () => {
    const prune = vi.fn(async (_cutoff: Date) => undefined);
    const result = await runBackupCheck({ store: store({ prune }), now: NOW });
    expect(result).toEqual({ failures: [], pruned: true });
    expect(prune).toHaveBeenCalledTimes(1);
    // The cutoff is a retention window in the past, not "now".
    expect(prune.mock.calls[0][0].getTime()).toBeLessThan(NOW);
  });

  it("reports a failed read rather than swallowing it", async () => {
    // The likely cause is the migration never having been applied — exactly
    // the state where silence must not read as a healthy backup.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runBackupCheck({
      store: store({
        latest: async () => {
          throw new Error("no such table: backup_runs");
        },
      }),
      now: NOW,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("no such table");
    vi.restoreAllMocks();
  });

  it("still checks freshness when the prune blows up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runBackupCheck({
      store: store({
        latest: async () => goodRun(500),
        prune: async () => {
          throw new Error("locked");
        },
      }),
      now: NOW,
    });
    expect(result.pruned).toBe(false);
    expect(result.failures.some((f) => f.includes("old"))).toBe(true);
    vi.restoreAllMocks();
  });
});
