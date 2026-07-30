/**
 * Follower history: the daily sampling pass that records it, and the pure
 * series math that reads it back honestly.
 *
 * WHY SAMPLE AT ALL. Bluesky's AppView reports a follower count as a
 * point-in-time number — `app.bsky.actor.getProfile` answers "how many
 * followers right now" and there is no history endpoint anywhere in the API.
 * Follower history therefore cannot be backfilled: any day nobody took a
 * reading is a permanent hole. So the sampling runs from the day it ships,
 * ahead of anything that draws a chart, and the read side (`snapshotSeries`)
 * is written to render a hole AS a hole rather than interpolate over it.
 *
 * SHAPE. Everything here is one of three things: a drizzle query builder
 * (awaitable, and verifiable via `.toSQL()` without a live D1), a pure
 * function, or — for the one piece that talks to the network — a function
 * taking an injectable fetcher. `SnapshotStore` exists so the pass itself can
 * be exercised against a plain object.
 */
import { and, eq, gte, like, lt, lte, max } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { followerSnapshots, oauthKv } from "~/db/schema";
import { type Did, isDid } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Days of history kept. 400 rather than 365 so a year-over-year comparison
 * still has a left-hand number to compare against. One row is ~40 bytes, so a
 * thousand writers cost ~16 MB — storage is not the constraint here. */
export const SNAPSHOT_RETENTION_DAYS = 400;

/** Writers sampled per cron run. At 50 × 24 hourly runs the pass covers ~1,000
 * writers a day with slack; anything that doesn't fit rolls to the next hour,
 * where the unique day key makes the retry free. */
export const MAX_SAMPLES_PER_RUN = 50;

/** A writer keeps being sampled while they have a session OR a sample this
 * recent — so signing out for a week doesn't amputate their chart. */
export const RECENT_WRITER_DAYS = 30;

/** Parallel AppView reads. The pass is I/O-bound; this bounds wall-clock time
 * without turning a public good into a thundering herd. */
export const SAMPLE_CONCURRENCY = 5;

/** Session rows in oauth_kv are keyed `sess:<did>` (see ~/lib/oauth's D1Store). */
const SESSION_KEY_PREFIX = "sess:";

/** Unauthenticated public AppView — a follower count is public data, and this
 * pass deliberately holds no writer's tokens. */
const APPVIEW_ORIGIN = "https://public.api.bsky.app";

const PROFILE_TIMEOUT_MS = 5_000;

/** A profile response is a few hundred bytes; anything near this is hostile
 * or broken, and we'd rather drop it than decode it. */
const MAX_PROFILE_BYTES = 65_536;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** A UTC calendar day, 'YYYY-MM-DD'. */
export function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
}

/** The UTC calendar day containing `at`. Days are UTC everywhere in this
 * module — no local-time arithmetic, so there is no DST edge to get wrong. */
export function utcDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** `day` shifted by whole days (negative goes backwards). */
export function shiftDay(day: string, delta: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + delta * MS_PER_DAY);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function dayDistance(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      MS_PER_DAY,
  );
}

/** A follower/post count we're willing to store: a real, non-negative whole
 * number. Anything else (string, NaN, negative, fractional) is a malformed
 * response, not a zero. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The DID inside an oauth_kv session key, or null.
 *
 * Deliberately an exact-length prefix strip plus a DID-syntax check — never a
 * regex over the raw key text. Key text is data, so the only safe assumption
 * is that some of it is junk (an abandoned row, a future key namespace); junk
 * is dropped rather than sampled.
 */
export function didFromSessionKey(key: unknown): Did | null {
  if (typeof key !== "string" || !key.startsWith(SESSION_KEY_PREFIX))
    return null;
  const did = key.slice(SESSION_KEY_PREFIX.length);
  return isDid(did) ? did : null;
}

/** Keys of every live session row. The LIKE pattern is the CONSTANT here and
 * the DID is never interpolated into one — which is what keeps this clear of
 * the wildcard hazard ~/lib/stats.ts documents (DIDs may legally contain `%`). */
export function selectSessionKeys(db: DrizzleD1) {
  return db
    .select({ k: oauthKv.k })
    .from(oauthKv)
    .where(like(oauthKv.k, `${SESSION_KEY_PREFIX}%`));
}

/** Every recently-sampled writer with the day they were last sampled — both
 * halves of the "who's still tracked, and who's most overdue" question in one
 * query. */
export function selectRecentSamples(db: DrizzleD1, sinceDay: string) {
  return db
    .select({
      did: followerSnapshots.did,
      lastDay: max(followerSnapshots.day),
    })
    .from(followerSnapshots)
    .where(gte(followerSnapshots.day, sinceDay))
    .groupBy(followerSnapshots.did);
}

export type NewSnapshot = {
  did: string;
  day: string;
  followers: number;
  posts: number | null;
};

/** Insert-if-absent. `onConflictDoNothing` against the (did, day) unique index
 * IS the idempotency: re-running the pass in the same UTC day is a no-op, so
 * an hourly cron self-heals a missed run without duplicating a day. */
export function insertSnapshot(db: DrizzleD1, row: NewSnapshot) {
  return db.insert(followerSnapshots).values(row).onConflictDoNothing();
}

/** One writer's samples across a day range, oldest first — the read a chart
 * makes. Scoped to a single DID in the WHERE, like every other per-writer
 * query in this codebase, and capped by construction (retention bounds how
 * many rows can exist). */
export function selectSnapshotRange(
  db: DrizzleD1,
  did: string,
  fromDay: string,
  toDay: string,
) {
  return db
    .select({
      day: followerSnapshots.day,
      followers: followerSnapshots.followers,
    })
    .from(followerSnapshots)
    .where(
      and(
        eq(followerSnapshots.did, did),
        gte(followerSnapshots.day, fromDay),
        lte(followerSnapshots.day, toDay),
      ),
    )
    .orderBy(followerSnapshots.day)
    .limit(SNAPSHOT_RETENTION_DAYS + 1);
}

/** Drop samples older than the retention window. Runs in the same cron pass
 * that writes, so the table can't grow without a matching prune. */
export function pruneSnapshots(db: DrizzleD1, beforeDay: string) {
  return db
    .delete(followerSnapshots)
    .where(lt(followerSnapshots.day, beforeDay));
}

/** The narrow slice of storage the sampling pass needs. One real
 * implementation (`d1SnapshotStore`); tests hand it a plain object. */
export type SnapshotStore = {
  sessionKeys(): Promise<string[]>;
  recentSamples(
    sinceDay: string,
  ): Promise<Array<{ did: string; lastDay: string | null }>>;
  insert(row: NewSnapshot): Promise<unknown>;
  prune(beforeDay: string): Promise<unknown>;
};

export function d1SnapshotStore(db: DrizzleD1): SnapshotStore {
  return {
    async sessionKeys() {
      return (await selectSessionKeys(db)).map((row) => row.k);
    },
    recentSamples(sinceDay) {
      return selectRecentSamples(db, sinceDay);
    },
    insert(row) {
      return insertSnapshot(db, row);
    },
    prune(beforeDay) {
      return pruneSnapshots(db, beforeDay);
    },
  };
}

/**
 * Who to sample this run, most overdue first — pure, so the ordering and the
 * cap are testable without a database.
 *
 * The tracked set is the union of writers with a live session and writers
 * already carrying a recent sample. Anyone already sampled today is skipped
 * (the insert would be a no-op anyway, but skipping saves the AppView call),
 * and the batch is capped so one run stays bounded.
 */
export function chooseSampleBatch(input: {
  sessionKeys: readonly string[];
  recentSamples: ReadonlyArray<{ did: string; lastDay: string | null }>;
  today: string;
  cap?: number;
}): Did[] {
  const {
    sessionKeys,
    recentSamples,
    today,
    cap = MAX_SAMPLES_PER_RUN,
  } = input;
  const lastSampled = new Map<Did, string | null>();

  for (const key of sessionKeys) {
    const did = didFromSessionKey(key);
    if (did) lastSampled.set(did, null);
  }
  for (const row of recentSamples) {
    // Our own rows, but validated anyway: a query that ever widened would
    // otherwise start spending AppView calls on junk.
    if (!isDid(row.did)) continue;
    const lastDay = isDay(row.lastDay) ? row.lastDay : null;
    const known = lastSampled.get(row.did) ?? null;
    lastSampled.set(
      row.did,
      lastDay && (!known || lastDay > known) ? lastDay : known,
    );
  }

  return [...lastSampled.entries()]
    .filter(([, lastDay]) => lastDay !== today)
    .sort(([didA, a], [didB, b]) => {
      // Never sampled sorts first, then oldest sample first. DID breaks ties so
      // a capped run is deterministic instead of hash-ordered.
      if (a !== b) return (a ?? "").localeCompare(b ?? "");
      return didA.localeCompare(didB);
    })
    .slice(0, Math.max(cap, 0))
    .map(([did]) => did);
}

export type ProfileCounts = { followers: number; posts: number | null };

/**
 * The counts inside a getProfile response, or null when there isn't a usable
 * follower number in it.
 *
 * Third-party network data, so every field is checked and nothing is
 * coalesced: a missing, negative, or non-numeric `followersCount` means NO ROW
 * IS WRITTEN, because a fabricated 0 would read as "this writer lost all their
 * followers that day" forever. A bad `postsCount` only costs the posts column.
 */
export function readProfileCounts(body: unknown): ProfileCounts | null {
  if (typeof body !== "object" || body === null) return null;
  const { followersCount, postsCount } = body as {
    followersCount?: unknown;
    postsCount?: unknown;
  };
  if (!isCount(followersCount)) return null;
  return {
    followers: followersCount,
    posts: isCount(postsCount) ? postsCount : null,
  };
}

/**
 * One writer's public follower count from the public AppView. Unauthenticated
 * (the number is public), bounded by a timeout and a body cap, and never
 * throws: a failure returns null so a single unreachable DID can't take the
 * whole pass down with it.
 */
export async function fetchProfileCounts(
  did: string,
  fetcher: typeof fetch = fetch,
): Promise<ProfileCounts | null> {
  const url = `${APPVIEW_ORIGIN}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`;
  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const bytes = await readBodyCapped(res, MAX_PROFILE_BYTES);
    if (!bytes) return null;
    return readProfileCounts(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** Run `task` over `items`, at most `limit` at a time. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
}

export type SnapshotPassResult = {
  day: string;
  /** How many writers this run tried to sample (post-cap). */
  attempted: number;
  /** Rows written or already present for today. */
  sampled: number;
  /** Writers whose sample couldn't be taken this hour — the next run retries. */
  failed: number;
  pruned: boolean;
};

/**
 * The daily sampling pass, run from the hourly cron.
 *
 * Bounded on purpose: a capped batch, a fixed concurrency, a per-request
 * timeout. It is I/O-bound — the work is waiting on the AppView, which doesn't
 * count against the worker's CPU budget.
 *
 * Never throws. A cron that throws just gets retried, and a retry of a
 * partially-completed pass is only cheap because of the idempotent insert;
 * logging and continuing keeps one bad writer from costing every other writer
 * their day's reading.
 */
export async function runFollowerSnapshotPass(opts: {
  store: SnapshotStore;
  now?: number;
  fetcher?: typeof fetch;
  cap?: number;
}): Promise<SnapshotPassResult> {
  const { store, now = Date.now(), fetcher = fetch, cap } = opts;
  const day = utcDay(now);
  const result: SnapshotPassResult = {
    day,
    attempted: 0,
    sampled: 0,
    failed: 0,
    pruned: false,
  };

  try {
    const [sessionKeys, recentSamples] = await Promise.all([
      store.sessionKeys(),
      store.recentSamples(shiftDay(day, -RECENT_WRITER_DAYS)),
    ]);
    const batch = chooseSampleBatch({
      sessionKeys,
      recentSamples,
      today: day,
      cap,
    });
    result.attempted = batch.length;

    await mapWithConcurrency(batch, SAMPLE_CONCURRENCY, async (did) => {
      const counts = await fetchProfileCounts(did, fetcher);
      if (!counts) {
        result.failed++;
        console.warn("no usable follower count", did);
        return;
      }
      try {
        await store.insert({
          did,
          day,
          followers: counts.followers,
          posts: counts.posts,
        });
        result.sampled++;
      } catch (err) {
        result.failed++;
        console.warn("follower snapshot insert failed", did, err);
      }
    });
  } catch (err) {
    console.error("follower snapshot sampling failed", err);
  }

  // Independent of sampling: a bad sampling hour is no reason to let the table
  // grow past its retention window.
  try {
    await store.prune(shiftDay(day, -SNAPSHOT_RETENTION_DAYS));
    result.pruned = true;
  } catch (err) {
    console.error("follower snapshot prune failed", err);
  }
  return result;
}

export type SnapshotPoint = { day: string; followers: number };

export type SnapshotSeries = {
  /** Contiguous runs of days, in order. A chart draws each run as one solid
   * segment, which is what keeps a gap looking like a gap. */
  runs: SnapshotPoint[][];
  /** Days between the first and last sample with no reading. */
  missingDays: number;
  firstDay: string | null;
  lastDay: string | null;
  /** Change from first to last sample; null when there's nothing to compare. */
  net: number | null;
  /** Fewer than two samples — there is no trend to show yet. */
  insufficient: boolean;
};

const EMPTY_SERIES: SnapshotSeries = {
  runs: [],
  missingDays: 0,
  firstDay: null,
  lastDay: null,
  net: null,
  insufficient: true,
};

/**
 * Turn stored samples into a plottable series — pure, no I/O.
 *
 * The single rule this function exists to enforce: A MISSING DAY MEANS NO
 * READING WAS TAKEN, NOT ZERO FOLLOWERS. So it never invents a point. Days
 * with samples are grouped into contiguous runs and the caller draws the
 * spaces between them as the absence they are.
 *
 * `missingDays` counts holes BETWEEN the first and last sample — days we were
 * watching and missed. Days before the first sample aren't missing, they're
 * before we started, which is why `firstDay` is reported separately: the left
 * edge of the chart is where our record begins, not where the writer did.
 */
export function snapshotSeries(
  rows: Iterable<{ day: unknown; followers: unknown }>,
  window: { from: string; to: string },
): SnapshotSeries {
  const { from, to } = window;
  if (!isDay(from) || !isDay(to) || from > to) return EMPTY_SERIES;

  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (!isDay(row.day) || row.day < from || row.day > to) continue;
    if (!isCount(row.followers)) continue;
    byDay.set(row.day, row.followers);
  }
  if (byDay.size === 0) return EMPTY_SERIES;

  const days = [...byDay.keys()].sort();
  const runs: SnapshotPoint[][] = [];
  let current: SnapshotPoint[] = [];
  let previous: string | null = null;
  for (const day of days) {
    if (previous !== null && day !== shiftDay(previous, 1)) {
      runs.push(current);
      current = [];
    }
    current.push({ day, followers: byDay.get(day) as number });
    previous = day;
  }
  runs.push(current);

  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  return {
    runs,
    missingDays: dayDistance(firstDay, lastDay) + 1 - days.length,
    firstDay,
    lastDay,
    net:
      days.length >= 2
        ? (byDay.get(lastDay) as number) - (byDay.get(firstDay) as number)
        : null,
    insufficient: days.length < 2,
  };
}
