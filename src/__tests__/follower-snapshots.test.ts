// @vitest-environment node

import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chooseSampleBatch,
  d1SnapshotStore,
  dayDistance,
  didFromSessionKey,
  fetchProfileCounts,
  insertSnapshot,
  MAX_SAMPLES_PER_RUN,
  pruneSnapshots,
  RECENT_WRITER_DAYS,
  readProfileCounts,
  runFollowerSnapshotPass,
  SNAPSHOT_RETENTION_DAYS,
  type SnapshotStore,
  selectRecentSamples,
  selectSessionKeys,
  selectSnapshotRange,
  shiftDay,
  snapshotSeries,
  utcDay,
} from "../lib/follower-snapshots";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Follower snapshots are the one thing in the analytics stack that cannot be
 * rebuilt if it goes wrong: upstream reports today's follower count and keeps
 * no history, so a bug that drops a day drops it permanently, and a bug that
 * writes a wrong number writes it forever. These tests therefore pin three
 * things hard — the writer set, the idempotency of a re-run, and the refusal to
 * invent a data point that was never sampled.
 */

const DID = "did:plc:fake2222222222writer2222";
const OTHER_DID = "did:plc:fakeforeign22222writer22";
const THIRD_DID = "did:plc:fakethird22222writer2222";

/** A distinct, syntactically real did:plc — the identifier body is 24
 * base32-sortable characters, so padding with digits outside that alphabet
 * would produce DIDs the writer set correctly refuses. */
function fakeDid(index: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let remaining = index;
  let body = "";
  for (let position = 0; position < 24; position++) {
    body += alphabet[remaining % 32];
    remaining = Math.floor(remaining / 32);
  }
  return `did:plc:${body}`;
}
// A Tuesday, deliberately mid-month so day arithmetic isn't accidentally right.
const NOW = Date.parse("2026-07-29T04:07:00.000Z");
const TODAY = "2026-07-29";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const buildDb = drizzle({} as any);

describe("UTC day arithmetic", () => {
  it("takes the UTC calendar day, never the local one", () => {
    // 23:30 UTC on the 29th is already the 30th in some timezones; snapshots
    // are UTC end to end so this must stay the 29th.
    expect(utcDay(Date.parse("2026-07-29T23:30:00.000Z"))).toBe("2026-07-29");
    expect(utcDay(Date.parse("2026-07-29T00:00:00.000Z"))).toBe("2026-07-29");
  });

  it("shifts across month, year, and leap-day boundaries", () => {
    expect(shiftDay("2026-07-29", 1)).toBe("2026-07-30");
    expect(shiftDay("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2026-07-29", -SNAPSHOT_RETENTION_DAYS)).toBe("2025-06-24");
  });

  it("measures whole days in both directions", () => {
    expect(dayDistance("2026-07-29", "2026-07-29")).toBe(0);
    expect(dayDistance("2026-07-29", "2026-08-05")).toBe(7);
    expect(dayDistance("2026-08-05", "2026-07-29")).toBe(-7);
  });
});

describe("didFromSessionKey — junk keys never become AppView calls", () => {
  it("reads the DID out of a session key", () => {
    expect(didFromSessionKey(`sess:${DID}`)).toBe(DID);
  });

  it("ignores every other key namespace and every malformed key", () => {
    for (const key of [
      `state:${DID}`, // authorize state, not a session
      DID, // no prefix
      "sess:", // empty
      "sess:not-a-did",
      "sess:did:plc:short",
      "sess:sess:did:plc:fake2222222222writer2222", // doubled prefix
      "",
      undefined,
      null,
      42,
    ]) {
      expect(didFromSessionKey(key)).toBeNull();
    }
  });
});

describe("the writer set — who gets sampled", () => {
  it("is the union of live sessions and recently-sampled writers", () => {
    // OTHER_DID signed out; they keep being sampled because they have recent
    // history, so signing out doesn't amputate an existing chart.
    const batch = chooseSampleBatch({
      sessionKeys: [`sess:${DID}`],
      recentSamples: [{ did: OTHER_DID, lastDay: "2026-07-28" }],
      today: TODAY,
    });
    expect(batch).toEqual([DID, OTHER_DID]);
  });

  it("skips writers already sampled today (the insert would be a no-op anyway)", () => {
    const batch = chooseSampleBatch({
      sessionKeys: [`sess:${DID}`, `sess:${OTHER_DID}`],
      recentSamples: [{ did: DID, lastDay: TODAY }],
      today: TODAY,
    });
    expect(batch).toEqual([OTHER_DID]);
  });

  it("orders never-sampled first, then longest-since-last-sample", () => {
    const batch = chooseSampleBatch({
      sessionKeys: [`sess:${DID}`, `sess:${OTHER_DID}`, `sess:${THIRD_DID}`],
      recentSamples: [
        { did: DID, lastDay: "2026-07-28" },
        { did: OTHER_DID, lastDay: "2026-07-02" },
      ],
      today: TODAY,
    });
    expect(batch).toEqual([THIRD_DID, OTHER_DID, DID]);
  });

  it("caps the batch, leaving the rest for the next hourly run", () => {
    const sessionKeys = Array.from(
      { length: MAX_SAMPLES_PER_RUN + 7 },
      (_, i) => `sess:${fakeDid(i)}`,
    );
    expect(
      chooseSampleBatch({ sessionKeys, recentSamples: [], today: TODAY }),
    ).toHaveLength(MAX_SAMPLES_PER_RUN);
    expect(
      chooseSampleBatch({
        sessionKeys,
        recentSamples: [],
        today: TODAY,
        cap: 3,
      }),
    ).toHaveLength(3);
  });

  it("drops junk on both sides rather than spending a fetch on it", () => {
    expect(
      chooseSampleBatch({
        sessionKeys: ["sess:garbage", `state:${DID}`],
        recentSamples: [{ did: "not-a-did", lastDay: "2026-07-28" }],
        today: TODAY,
      }),
    ).toEqual([]);
  });

  it("de-duplicates a writer who is both signed in and recently sampled", () => {
    expect(
      chooseSampleBatch({
        sessionKeys: [`sess:${DID}`],
        recentSamples: [{ did: DID, lastDay: "2026-07-27" }],
        today: TODAY,
      }),
    ).toEqual([DID]);
  });
});

describe("readProfileCounts — absent is never zero", () => {
  it("reads a well-formed profile", () => {
    expect(readProfileCounts({ followersCount: 1234, postsCount: 12 })).toEqual(
      {
        followers: 1234,
        posts: 12,
      },
    );
  });

  it("writes no row at all when the follower count isn't a usable number", () => {
    for (const body of [
      {},
      { followersCount: "1234" },
      { followersCount: -1 },
      { followersCount: 12.5 },
      { followersCount: Number.NaN },
      { followersCount: Number.POSITIVE_INFINITY },
      { followersCount: null },
      { profile: { followersCount: 5 } },
      null,
      "nope",
      [],
    ]) {
      expect(readProfileCounts(body)).toBeNull();
    }
  });

  it("keeps the follower count when only the post count is malformed", () => {
    expect(
      readProfileCounts({ followersCount: 7, postsCount: "many" }),
    ).toEqual({
      followers: 7,
      posts: null,
    });
  });

  it("accepts a genuine zero — a new account really can have no followers", () => {
    expect(readProfileCounts({ followersCount: 0 })).toEqual({
      followers: 0,
      posts: null,
    });
  });
});

describe("fetchProfileCounts — bounded, unauthenticated, never throws", () => {
  it("calls the public AppView with the DID encoded, and no credentials", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({ followersCount: 9, postsCount: 3 }),
    );
    expect(
      await fetchProfileCounts(
        "did:web:writer.example",
        fetcher as unknown as typeof fetch,
      ),
    ).toEqual({ followers: 9, posts: 3 });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did%3Aweb%3Awriter.example",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // No authorization header: a follower count is public, so this pass never
    // touches a writer's tokens.
    expect(init?.headers).toBeUndefined();
  });

  it("returns null (no row) on a non-2xx, a thrown fetch, or a non-JSON body", async () => {
    expect(
      await fetchProfileCounts(
        DID,
        async () => new Response("", { status: 429 }),
      ),
    ).toBeNull();
    expect(
      await fetchProfileCounts(DID, async () => {
        throw new Error("timed out");
      }),
    ).toBeNull();
    expect(
      await fetchProfileCounts(DID, async () => new Response("<html>")),
    ).toBeNull();
  });

  it("refuses an oversized body instead of decoding it", async () => {
    const huge = `{"followersCount":1,"pad":"${"x".repeat(70_000)}"}`;
    expect(
      await fetchProfileCounts(DID, async () => new Response(huge)),
    ).toBeNull();
  });
});

describe("runFollowerSnapshotPass — one bad writer can't cost the others their day", () => {
  function fakeStore(overrides: Partial<SnapshotStore> = {}) {
    const inserted: unknown[] = [];
    const pruned: string[] = [];
    const store: SnapshotStore & { inserted: unknown[]; pruned: string[] } = {
      inserted,
      pruned,
      sessionKeys: async () => [`sess:${DID}`, `sess:${OTHER_DID}`],
      recentSamples: async () => [],
      async insert(row) {
        inserted.push(row);
      },
      async prune(beforeDay) {
        pruned.push(beforeDay);
      },
      ...overrides,
    };
    return store;
  }

  const okFetcher = () =>
    vi.fn(async () => Response.json({ followersCount: 10, postsCount: 2 }));

  it("writes one row per writer, stamped with today's UTC day", async () => {
    const store = fakeStore();
    const result = await runFollowerSnapshotPass({
      store,
      now: NOW,
      fetcher: okFetcher(),
    });
    expect(result).toMatchObject({
      day: TODAY,
      attempted: 2,
      sampled: 2,
      failed: 0,
      pruned: true,
    });
    expect(store.inserted).toEqual([
      { did: DID, day: TODAY, followers: 10, posts: 2 },
      { did: OTHER_DID, day: TODAY, followers: 10, posts: 2 },
    ]);
  });

  it("asks for recent samples over the tracking window, not all of history", async () => {
    const recentSamples = vi.fn(async () => []);
    await runFollowerSnapshotPass({
      store: fakeStore({ recentSamples }),
      now: NOW,
      fetcher: okFetcher(),
    });
    expect(recentSamples).toHaveBeenCalledWith(
      shiftDay(TODAY, -RECENT_WRITER_DAYS),
    );
  });

  it("keeps going when one writer's AppView read fails", async () => {
    const store = fakeStore();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(encodeURIComponent(DID)))
        throw new Error("upstream down");
      return Response.json({ followersCount: 4 });
    });
    const result = await runFollowerSnapshotPass({
      store,
      now: NOW,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ attempted: 2, sampled: 1, failed: 1 });
    expect(store.inserted).toEqual([
      { did: OTHER_DID, day: TODAY, followers: 4, posts: null },
    ]);
  });

  it("keeps going when one writer's insert fails", async () => {
    let calls = 0;
    const store = fakeStore({
      async insert() {
        calls++;
        if (calls === 1) throw new Error("D1 hiccup");
      },
    });
    const result = await runFollowerSnapshotPass({
      store,
      now: NOW,
      fetcher: okFetcher(),
    });
    expect(result).toMatchObject({ attempted: 2, sampled: 1, failed: 1 });
  });

  it("never sends more requests than the per-run cap", async () => {
    const fetcher = okFetcher();
    const sessionKeys = async () =>
      Array.from({ length: 40 }, (_, i) => `sess:${fakeDid(i)}`);
    const result = await runFollowerSnapshotPass({
      store: fakeStore({ sessionKeys }),
      now: NOW,
      fetcher,
      cap: 5,
    });
    expect(result.attempted).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("prunes past the retention window, and still prunes when sampling fails", async () => {
    const ok = fakeStore();
    await runFollowerSnapshotPass({
      store: ok,
      now: NOW,
      fetcher: okFetcher(),
    });
    expect(ok.pruned).toEqual([shiftDay(TODAY, -SNAPSHOT_RETENTION_DAYS)]);

    const broken = fakeStore({
      sessionKeys: async () => {
        throw new Error("D1 unavailable");
      },
    });
    const result = await runFollowerSnapshotPass({
      store: broken,
      now: NOW,
      fetcher: okFetcher(),
    });
    expect(result).toMatchObject({ attempted: 0, sampled: 0, pruned: true });
    expect(broken.pruned).toHaveLength(1);
  });

  it("reports (never throws) when even the prune fails — a cron must not die", async () => {
    const store = fakeStore({
      async prune() {
        throw new Error("D1 unavailable");
      },
    });
    const result = await runFollowerSnapshotPass({
      store,
      now: NOW,
      fetcher: okFetcher(),
    });
    expect(result.pruned).toBe(false);
    expect(result.sampled).toBe(2);
  });

  it("defaults to the global fetch when none is injected", async () => {
    const spy = vi.fn(async () => Response.json({ followersCount: 1 }));
    vi.stubGlobal("fetch", spy);
    const store = fakeStore({ sessionKeys: async () => [`sess:${DID}`] });
    await runFollowerSnapshotPass({ store, now: NOW });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("the SQL, against a real SQLite built from the committed migration", () => {
  /**
   * The migration and the schema can drift, and the thing keeping one row per
   * writer per day is an index inside the migration — not application code. So
   * these run the real statements against the real DDL rather than asserting on
   * SQL strings: if the unique index were ever dropped from a migration, the
   * idempotency test below fails loudly.
   */
  function migrationStatements(table: string): string[] {
    const dir = new URL("../../drizzle/", import.meta.url);
    return readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .flatMap((file) =>
        readFileSync(new URL(file, dir), "utf8").split(
          "--> statement-breakpoint",
        ),
      )
      .map((statement) => statement.trim())
      .filter((statement) => statement.includes(table));
  }

  function freshDb() {
    const sqlite = new DatabaseSync(":memory:");
    const statements = migrationStatements("follower_snapshots");
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) sqlite.exec(statement);
    return sqlite;
  }

  type Builder = { toSQL(): { sql: string; params: unknown[] } };
  function run(sqlite: DatabaseSync, builder: Builder) {
    const { sql, params } = builder.toSQL();
    // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
    return sqlite.prepare(sql).run(...(params as any[]));
  }
  function all(sqlite: DatabaseSync, builder: Builder) {
    const { sql, params } = builder.toSQL();
    // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
    return sqlite.prepare(sql).all(...(params as any[]));
  }
  function rowCount(sqlite: DatabaseSync) {
    const row = sqlite
      .prepare("select count(*) as c from follower_snapshots")
      .get() as { c: number };
    return row.c;
  }

  it("re-running the pass in the same UTC day writes exactly one row", () => {
    const sqlite = freshDb();
    const row = { did: DID, day: TODAY, followers: 10, posts: 1 };
    run(sqlite, insertSnapshot(buildDb, row));
    // The 05:00 run, then the 06:00 run, then a retried 06:00 run — including
    // one where the count has since changed. First reading of the day wins.
    run(sqlite, insertSnapshot(buildDb, row));
    run(sqlite, insertSnapshot(buildDb, { ...row, followers: 11 }));
    expect(rowCount(sqlite)).toBe(1);
    expect(
      all(sqlite, selectSnapshotRange(buildDb, DID, TODAY, TODAY)),
    ).toEqual([{ day: TODAY, followers: 10 }]);
  });

  it("keeps one row per DID per day — different writers and days coexist", () => {
    const sqlite = freshDb();
    for (const row of [
      { did: DID, day: "2026-07-28", followers: 8, posts: null },
      { did: DID, day: TODAY, followers: 10, posts: null },
      { did: OTHER_DID, day: TODAY, followers: 99, posts: null },
    ]) {
      run(sqlite, insertSnapshot(buildDb, row));
      run(sqlite, insertSnapshot(buildDb, row)); // every insert, twice
    }
    expect(rowCount(sqlite)).toBe(3);
  });

  it("the range read returns only the caller's rows, only in range, oldest first", () => {
    const sqlite = freshDb();
    for (const row of [
      { did: DID, day: "2026-07-20", followers: 1, posts: null },
      { did: DID, day: "2026-07-27", followers: 3, posts: null },
      { did: DID, day: "2026-07-25", followers: 2, posts: null },
      { did: OTHER_DID, day: "2026-07-26", followers: 500, posts: null },
    ]) {
      run(sqlite, insertSnapshot(buildDb, row));
    }
    expect(
      all(sqlite, selectSnapshotRange(buildDb, DID, "2026-07-25", TODAY)),
    ).toEqual([
      { day: "2026-07-25", followers: 2 },
      { day: "2026-07-27", followers: 3 },
    ]);
  });

  it("the prune boundary keeps the oldest retained day and drops the one before it", () => {
    const sqlite = freshDb();
    const oldest = shiftDay(TODAY, -SNAPSHOT_RETENTION_DAYS);
    const tooOld = shiftDay(TODAY, -SNAPSHOT_RETENTION_DAYS - 1);
    for (const day of [tooOld, oldest, TODAY]) {
      run(
        sqlite,
        insertSnapshot(buildDb, { did: DID, day, followers: 1, posts: null }),
      );
    }
    run(sqlite, pruneSnapshots(buildDb, oldest));
    expect(
      all(sqlite, selectSnapshotRange(buildDb, DID, "1970-01-01", TODAY)).map(
        (r) => (r as { day: string }).day,
      ),
    ).toEqual([oldest, TODAY]);
  });

  it("the d1 store's writer-set queries are DID-free and prefix-exact", () => {
    const sessions = selectSessionKeys(buildDb).toSQL();
    // The pattern is the constant 'sess:%' — a DID is never interpolated into a
    // LIKE pattern, where a legal `%` in a did:web would act as a wildcard.
    expect(sessions.params).toEqual(["sess:%"]);
    expect(sessions.sql.toLowerCase()).toContain('from "oauth_kv"');

    const recent = selectRecentSamples(buildDb, "2026-06-29").toSQL();
    expect(recent.sql.toLowerCase()).toContain("group by");
    expect(recent.sql.toLowerCase()).toContain("max(");
    expect(recent.params).toEqual(["2026-06-29"]);
  });

  it("the store adapter hands back plain session keys, filtering nothing", async () => {
    // Filtering is chooseSampleBatch's job, so the adapter must not quietly
    // drop rows on the way — a `state:` key reaching it is expected and
    // harmless, and losing a `sess:` key would silently stop sampling someone.
    const rows = [{ k: `sess:${DID}` }, { k: "state:abandoned-login" }];
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as typeof buildDb;
    await expect(d1SnapshotStore(fakeDb).sessionKeys()).resolves.toEqual([
      `sess:${DID}`,
      "state:abandoned-login",
    ]);
  });
});

describe("snapshotSeries — a missing day is a missing reading, never a zero", () => {
  const window = { from: "2026-07-01", to: "2026-07-10" };

  it("has nothing to say about an empty series", () => {
    expect(snapshotSeries([], window)).toEqual({
      runs: [],
      missingDays: 0,
      firstDay: null,
      lastDay: null,
      net: null,
      insufficient: true,
    });
  });

  it("reports a single sample as insufficient, with no trend invented", () => {
    const series = snapshotSeries(
      [{ day: "2026-07-03", followers: 40 }],
      window,
    );
    expect(series.runs).toEqual([[{ day: "2026-07-03", followers: 40 }]]);
    expect(series.insufficient).toBe(true);
    expect(series.net).toBeNull();
    expect(series.missingDays).toBe(0);
    expect(series.firstDay).toBe("2026-07-03");
    expect(series.lastDay).toBe("2026-07-03");
  });

  it("joins consecutive days into one run", () => {
    const series = snapshotSeries(
      [
        { day: "2026-07-01", followers: 10 },
        { day: "2026-07-02", followers: 12 },
        { day: "2026-07-03", followers: 15 },
      ],
      window,
    );
    expect(series.runs).toHaveLength(1);
    expect(series.runs[0]).toHaveLength(3);
    expect(series.missingDays).toBe(0);
    expect(series.net).toBe(5);
    expect(series.insufficient).toBe(false);
  });

  it("splits at an interior gap instead of drawing a line through it", () => {
    const series = snapshotSeries(
      [
        { day: "2026-07-01", followers: 10 },
        { day: "2026-07-02", followers: 12 },
        // 03 + 04 missing: the cron didn't run, or upstream was down
        { day: "2026-07-05", followers: 20 },
      ],
      window,
    );
    expect(series.runs.map((run) => run.map((p) => p.day))).toEqual([
      ["2026-07-01", "2026-07-02"],
      ["2026-07-05"],
    ]);
    expect(series.missingDays).toBe(2);
    expect(series.net).toBe(10);
  });

  it("splits at every gap, including single-day ones", () => {
    const series = snapshotSeries(
      [
        { day: "2026-07-01", followers: 1 },
        { day: "2026-07-03", followers: 2 },
        { day: "2026-07-05", followers: 3 },
      ],
      window,
    );
    expect(series.runs).toHaveLength(3);
    expect(series.runs.every((run) => run.length === 1)).toBe(true);
    expect(series.missingDays).toBe(2);
  });

  it("treats the space before the first and after the last sample as our record's edges, not as missing readings", () => {
    // Samples start on the 4th and stop on the 7th inside a 1st-to-10th window:
    // the days outside aren't holes, they're before we started watching (or
    // after we stopped), which firstDay/lastDay say plainly.
    const series = snapshotSeries(
      [
        { day: "2026-07-04", followers: 10 },
        { day: "2026-07-05", followers: 11 },
        { day: "2026-07-07", followers: 9 },
      ],
      window,
    );
    expect(series.firstDay).toBe("2026-07-04");
    expect(series.lastDay).toBe("2026-07-07");
    expect(series.missingDays).toBe(1); // the 6th only
    expect(series.runs.flat().map((p) => p.day)).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-07",
    ]);
  });

  it("handles a falling count (people unfollow) without special-casing it", () => {
    const series = snapshotSeries(
      [
        { day: "2026-07-01", followers: 100 },
        { day: "2026-07-02", followers: 90 },
      ],
      window,
    );
    expect(series.net).toBe(-10);
    expect(series.runs).toHaveLength(1);
  });

  it("sorts unordered rows and clips rows outside the window", () => {
    const series = snapshotSeries(
      [
        { day: "2026-07-05", followers: 3 },
        { day: "2026-06-30", followers: 999 }, // before the window
        { day: "2026-07-04", followers: 2 },
        { day: "2026-07-11", followers: 999 }, // after the window
      ],
      window,
    );
    expect(series.runs.flat()).toEqual([
      { day: "2026-07-04", followers: 2 },
      { day: "2026-07-05", followers: 3 },
    ]);
  });

  it("drops unreadable rows rather than plotting them", () => {
    const series = snapshotSeries(
      [
        { day: "2026-07-04", followers: 2 },
        { day: "not-a-day", followers: 5 },
        { day: "2026-07-05", followers: "7" },
        { day: "2026-07-06", followers: -1 },
        { day: null, followers: 1 },
      ],
      window,
    );
    expect(series.runs.flat()).toEqual([{ day: "2026-07-04", followers: 2 }]);
    expect(series.insufficient).toBe(true);
  });

  it("returns nothing for a nonsensical window", () => {
    const rows = [{ day: "2026-07-04", followers: 2 }];
    expect(
      snapshotSeries(rows, { from: "2026-07-10", to: "2026-07-01" }).runs,
    ).toEqual([]);
    expect(
      snapshotSeries(rows, { from: "nope", to: "2026-07-10" }).runs,
    ).toEqual([]);
  });

  it("keeps a full retention window in a single run", () => {
    const rows = Array.from({ length: SNAPSHOT_RETENTION_DAYS }, (_, i) => ({
      day: shiftDay("2025-06-24", i),
      followers: i,
    }));
    const series = snapshotSeries(rows, {
      from: "2025-06-24",
      to: shiftDay("2025-06-24", SNAPSHOT_RETENTION_DAYS),
    });
    expect(series.runs).toHaveLength(1);
    expect(series.missingDays).toBe(0);
    expect(series.net).toBe(SNAPSHOT_RETENTION_DAYS - 1);
  });
});
