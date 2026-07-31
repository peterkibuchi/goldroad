/**
 * The /api/stats response envelope, and the pure functions that assemble each
 * section of it.
 *
 * WHY SECTIONS. The analytics surface draws on four independent upstreams: the
 * PostHog Query API (reader counts, traffic sources), our own D1 (follower
 * history), and the public Bluesky AppView (the conversation). A single
 * response shape with a single status would mean one dead upstream blanks a
 * page where three quarters of the numbers were available — so every section
 * carries its own status, is computed in its own settled promise, and is cached
 * under its own key. There is no code path in which one failure produces a
 * blank page or a non-200.
 *
 * Everything in this file is pure: it takes already-fetched rows and returns
 * the section a client renders. That keeps the honesty rules — absent is not
 * zero, a comparison is only shown when the two windows are comparable — in
 * unit tests rather than in a route handler.
 */
import type { EngagementCounts } from "~/lib/engagement";
import { type SnapshotSeries, shiftDay } from "~/lib/follower-snapshots";
import {
  bucketReferrers,
  type ReferrerRow,
  type SourceBucket,
} from "~/lib/referrers";
import {
  type DayRow,
  type DomainRow,
  type PathRow,
  rangeDays,
  type StatsRange,
} from "~/lib/stats";

export type SectionStatus =
  | "ok"
  | "unavailable"
  | "not_configured"
  | "insufficient_history"
  | "empty";

/**
 * Is this status a FAULT — something broken that somebody should know about —
 * or simply an answer?
 *
 * Only `unavailable` is a fault. The distinction is the whole point and it is
 * easy to get wrong in the direction of noise:
 *
 *   not_configured       — no PostHog key in this environment. Correct, and
 *                          permanent until someone sets one. Reporting it
 *                          would fire on every dev request forever.
 *   insufficient_history — we have not been collecting long enough to compare
 *                          two windows. Working exactly as designed; it fixes
 *                          itself by the passage of time.
 *   empty                — the upstream answered, and the answer is that
 *                          nothing happened yet. A real reading, not a gap.
 *                          Treating it as a fault is the same mistake as
 *                          rendering it as a zero.
 *
 * Exported and pure so the rule lives in one testable place rather than in a
 * condition inside a route handler, where the next section added would have to
 * remember it.
 */
export function isDegraded(status: SectionStatus): boolean {
  return status === "unavailable";
}

export type ViewsSection = {
  status: SectionStatus;
  total?: number;
  previousTotal?: number;
  /** Resolved SERVER-side: whether the previous window is a window we could
   * actually have collected. Absent/false ⇒ the client shows no delta. */
  comparable?: boolean;
  /** The earliest day we have any reading for — the chart's true left edge. */
  firstDay?: string;
  series?: DayRow[];
  paths?: PathRow[];
};

export type SourcesSection = {
  status: SectionStatus;
  total?: number;
  buckets?: Array<{ bucket: SourceBucket; views: number }>;
  topOtherDomains?: ReferrerRow[];
};

export type FollowersSection = {
  status: SectionStatus;
  current?: number;
  currentDay?: string;
  /** The day our record starts — not the day the writer started. */
  since?: string;
  missingDays?: number;
  net?: number;
  series?: Array<{ day: string; followers: number }>;
};

export type EngagementPost = {
  /** The document this announcement belongs to. */
  rkey: string;
  /** The announcement's thread on Bluesky. */
  did: string;
  postRkey: string;
  likes: number | null;
  reposts: number | null;
  quotes: number | null;
  replies: number | null;
  /** The announcement isn't on Bluesky anymore (deleted, blocked, taken down).
   * The row still renders — a vanished row reads as a bug. */
  gone?: true;
};

export type EngagementSection = {
  status: SectionStatus;
  totals?: { likes: number; reposts: number; quotes: number; replies: number };
  /** Partial-failure honesty: a total presented as complete when it isn't is
   * the worst outcome available here. */
  countedPosts?: number;
  requestedPosts?: number;
  posts?: EngagementPost[];
  /** Posts with no announcement — reported as a count, never as zero rows. */
  unannouncedCount?: number;
};

export type StatsEnvelope = {
  range: StatsRange;
  /** ISO, for the surface's "updated" line. */
  generatedAt: string;
  views: ViewsSection;
  sources: SourcesSection;
  followers: FollowersSection;
  engagement: EngagementSection;
};

/** The window a range means, in UTC days. `from === null` for "all time". */
export type RangeWindow = {
  from: string | null;
  to: string;
  /** The previous window of the same length, when one exists. */
  previousFrom: string | null;
  previousTo: string | null;
};

/**
 * The current and previous windows for a range, anchored on today.
 *
 * "All time" deliberately has no previous window: there is no previous all
 * time, so a comparison there would be arithmetic dressed as insight.
 */
export function rangeWindow(range: StatsRange, today: string): RangeWindow {
  const days = rangeDays(range);
  if (days === null)
    return { from: null, to: today, previousFrom: null, previousTo: null };
  return {
    from: shiftDay(today, -(days - 1)),
    to: today,
    previousFrom: shiftDay(today, -(2 * days - 1)),
    previousTo: shiftDay(today, -days),
  };
}

/**
 * How far back the day query needs to reach for a range.
 *
 * One day further than the previous window, deliberately: that extra day is the
 * probe that answers "was there anything before the window we're comparing
 * against?". Without it the earliest day we can see is always the query floor
 * itself, and the comparability rule below could never distinguish "the writer
 * existed before this window" from "the query started here".
 */
export function queryFloorDay(range: StatsRange, today: string): string | null {
  const days = rangeDays(range);
  return days === null ? null : shiftDay(today, -2 * days);
}

function sumViews(rows: readonly DayRow[]): number {
  let total = 0;
  for (const row of rows) total += row.views;
  return total;
}

/**
 * The views section from a day series and a path series.
 *
 * THE COMPARISON RULE, which most dashboards skip. A previous-period delta is a
 * claim about two comparable windows, so it is only offered when all three hold:
 *
 *  1. the range is a fixed window (never "all time");
 *  2. the previous window is one we could have collected — the earliest day we
 *     have any reading for is on or before its first day. Otherwise we would be
 *     comparing this month against a month in which the publication did not
 *     exist, and reporting "up 4,800%";
 *  3. the previous window's total is above zero. A percentage change from zero
 *     is undefined, and an infinity symbol in a stat card is a bug wearing a
 *     party hat.
 */
export function viewsSection(input: {
  days: DayRow[];
  paths: PathRow[];
  range: StatsRange;
  today: string;
}): ViewsSection {
  const { days, paths, range, today } = input;
  const window = rangeWindow(range, today);
  const inRange = (row: DayRow) =>
    (window.from === null || row.day >= window.from) && row.day <= window.to;

  const series = days.filter(inRange);
  const total = sumViews(series);
  const firstDay = days.length > 0 ? days[0].day : undefined;

  const previous =
    window.previousFrom !== null && window.previousTo !== null
      ? days.filter(
          (row) =>
            row.day >= (window.previousFrom as string) &&
            row.day <= (window.previousTo as string),
        )
      : null;
  const previousTotal = previous === null ? undefined : sumViews(previous);

  const comparable =
    previousTotal !== undefined &&
    previousTotal > 0 &&
    firstDay !== undefined &&
    window.previousFrom !== null &&
    firstDay <= window.previousFrom;

  return {
    status: days.length === 0 ? "empty" : "ok",
    total,
    ...(previousTotal === undefined ? {} : { previousTotal }),
    comparable,
    ...(firstDay === undefined ? {} : { firstDay }),
    series,
    paths,
  };
}

/** Below this many views a breakdown is noise dressed as insight: three views
 * rendered as "67% Bluesky / 33% Search" tells a writer nothing true. */
export const MIN_VIEWS_FOR_SOURCES = 10;

export function sourcesSection(input: {
  domains: DomainRow[];
  total: number;
}): SourcesSection {
  const { domains, total } = input;
  if (total <= 0) return { status: "empty", total: 0 };
  if (total < MIN_VIEWS_FOR_SOURCES)
    return { status: "insufficient_history", total };
  const bucketed = bucketReferrers(domains, total);
  return {
    status: "ok",
    total: bucketed.total,
    buckets: bucketed.buckets,
    topOtherDomains: bucketed.topOtherDomains,
  };
}

/**
 * The followers section from the stored snapshot series.
 *
 * A single snapshot is `insufficient_history`, not `ok` with a flat line: one
 * reading is a number, not a trend, and drawing an axis around it reads as
 * broken. The value itself still renders — it's true.
 */
export function followersSection(input: {
  series: SnapshotSeries;
  /** Today's snapshot may sit outside the requested window on a stale range;
   * the current value always comes from the newest sample we have. */
  latest?: { day: string; followers: number } | null;
}): FollowersSection {
  const { series, latest } = input;
  const flat = series.runs.flat();
  const newest =
    latest ?? (flat.length > 0 ? flat[flat.length - 1] : undefined) ?? null;
  if (newest === null) return { status: "empty" };

  const base: FollowersSection = {
    status: series.insufficient ? "insufficient_history" : "ok",
    current: newest.followers,
    currentDay: newest.day,
    ...(series.firstDay === null ? {} : { since: series.firstDay }),
  };
  if (series.insufficient) return base;
  return {
    ...base,
    missingDays: series.missingDays,
    ...(series.net === null ? {} : { net: series.net }),
    series: flat,
  };
}

/** The counts a post contributed, with absent left absent. Each count is
 * OPTIONAL in the AppView's lexicon: a missing number means we have no number,
 * which is a different claim from zero and must never be coalesced into one. */
function countOrNull(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

export function engagementSection(input: {
  /** Announced posts inside the range, newest first. */
  announced: Array<{
    rkey: string;
    uri: string;
    did: string;
    postRkey: string;
  }>;
  byUri: Map<string, EngagementCounts | "gone">;
  requested: number;
  answered: number;
  unannouncedCount: number;
}): EngagementSection {
  const { announced, byUri, requested, answered, unannouncedCount } = input;
  if (announced.length === 0)
    return { status: "empty", unannouncedCount, requestedPosts: 0 };

  // Every batch failed: no post has an answer, so there is nothing honest to
  // aggregate. One batch failing is a partial, reported below.
  if (requested > 0 && answered === 0)
    return {
      status: "unavailable",
      requestedPosts: requested,
      unannouncedCount,
    };

  const totals = { likes: 0, reposts: 0, quotes: 0, replies: 0 };
  const posts: EngagementPost[] = [];
  let countedPosts = 0;

  for (const post of announced) {
    const entry = byUri.get(post.uri);
    if (entry === "gone") {
      posts.push({
        rkey: post.rkey,
        did: post.did,
        postRkey: post.postRkey,
        likes: null,
        reposts: null,
        quotes: null,
        replies: null,
        gone: true,
      });
      continue;
    }
    if (entry === undefined) {
      // The batch carrying this post didn't answer. Its row degrades to dashes
      // rather than being dropped, and it is not counted in the totals.
      posts.push({
        rkey: post.rkey,
        did: post.did,
        postRkey: post.postRkey,
        likes: null,
        reposts: null,
        quotes: null,
        replies: null,
      });
      continue;
    }
    countedPosts++;
    totals.likes += entry.likeCount ?? 0;
    totals.reposts += entry.repostCount ?? 0;
    totals.quotes += entry.quoteCount ?? 0;
    totals.replies += entry.replyCount ?? 0;
    posts.push({
      rkey: post.rkey,
      did: post.did,
      postRkey: post.postRkey,
      likes: countOrNull(entry.likeCount),
      reposts: countOrNull(entry.repostCount),
      quotes: countOrNull(entry.quoteCount),
      replies: countOrNull(entry.replyCount),
    });
  }

  // Most conversation first — the ordering a writer actually wants — with the
  // rows we have no numbers for falling to the end rather than to the top.
  const weight = (p: EngagementPost) =>
    (p.likes ?? 0) + (p.reposts ?? 0) + (p.quotes ?? 0) + (p.replies ?? 0);
  const unknown = (p: EngagementPost) =>
    p.likes === null && p.reposts === null && p.quotes === null;
  posts.sort(
    (a, b) => Number(unknown(a)) - Number(unknown(b)) || weight(b) - weight(a),
  );

  return {
    status: "ok",
    totals,
    countedPosts,
    requestedPosts: announced.length,
    posts,
    unannouncedCount,
  };
}
