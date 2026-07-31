// @vitest-environment node
import { describe, expect, it } from "vitest";

import { snapshotSeries } from "../lib/follower-snapshots";
import type { DayRow } from "../lib/stats";
import {
  engagementSection,
  followersSection,
  isDegraded,
  MIN_VIEWS_FOR_SOURCES,
  queryFloorDay,
  rangeWindow,
  type SectionStatus,
  sourcesSection,
  viewsSection,
} from "../lib/stats-sections";

const TODAY = "2026-07-30";

describe("rangeWindow / queryFloorDay", () => {
  it("anchors a fixed window on today and lines the previous one up behind it", () => {
    expect(rangeWindow("7d", TODAY)).toEqual({
      from: "2026-07-24",
      to: "2026-07-30",
      previousFrom: "2026-07-17",
      previousTo: "2026-07-23",
    });
  });

  it("gives all-time no window and no previous window", () => {
    expect(rangeWindow("all", TODAY)).toEqual({
      from: null,
      to: TODAY,
      previousFrom: null,
      previousTo: null,
    });
    expect(queryFloorDay("all", TODAY)).toBeNull();
  });

  it("reaches one day further back than the previous window", () => {
    // That extra day is the probe that answers "was there anything at all
    // before the window we're comparing against?".
    expect(queryFloorDay("7d", TODAY)).toBe("2026-07-16");
    expect(rangeWindow("7d", TODAY).previousFrom).toBe("2026-07-17");
  });
});

/** A day series where every day in `days` has `views` views. */
function series(days: string[], views = 1): DayRow[] {
  return days.map((day) => ({ day, views }));
}

describe("viewsSection — the comparison rule", () => {
  it("totals the current window and the previous one separately", () => {
    const section = viewsSection({
      days: [
        { day: "2026-07-17", views: 100 }, // previous window
        { day: "2026-07-25", views: 30 }, // current window
        { day: "2026-07-26", views: 20 },
      ],
      paths: [],
      range: "7d",
      today: TODAY,
    });
    expect(section.total).toBe(50);
    expect(section.previousTotal).toBe(100);
    expect(section.series?.map((row) => row.day)).toEqual([
      "2026-07-25",
      "2026-07-26",
    ]);
  });

  it("shows a comparison when all three rules hold", () => {
    const section = viewsSection({
      // The probe day carries traffic, so data existed before the previous
      // window: the two windows are genuinely comparable.
      days: series(["2026-07-16", "2026-07-18", "2026-07-26"], 10),
      paths: [],
      range: "7d",
      today: TODAY,
    });
    expect(section.comparable).toBe(true);
  });

  it("refuses a comparison when the publication didn't exist yet", () => {
    // Nothing before the previous window's first day: comparing this week
    // against a week that didn't exist is how a dashboard reports "up 4,800%".
    const section = viewsSection({
      days: series(["2026-07-25", "2026-07-26"], 10),
      paths: [],
      range: "7d",
      today: TODAY,
    });
    expect(section.comparable).toBe(false);
  });

  it("refuses a comparison against a previous window of zero", () => {
    // A percentage change from nothing is undefined.
    const section = viewsSection({
      days: series(["2026-07-16", "2026-07-25"], 10),
      paths: [],
      range: "7d",
      today: TODAY,
    });
    expect(section.previousTotal).toBe(0);
    expect(section.comparable).toBe(false);
  });

  it("never emits a comparison for all time — there is no previous all time", () => {
    const section = viewsSection({
      days: series(["2025-01-01", "2026-07-29"], 500),
      paths: [],
      range: "all",
      today: TODAY,
    });
    expect(section.previousTotal).toBeUndefined();
    expect(section.comparable).toBe(false);
    expect(section.status).toBe("ok");
  });

  it("reports the earliest day we can see as the series' true left edge", () => {
    const section = viewsSection({
      days: series(["2026-07-18", "2026-07-25"]),
      paths: [],
      range: "7d",
      today: TODAY,
    });
    expect(section.firstDay).toBe("2026-07-18");
  });

  it("reports empty rather than a total of zero when nothing came back", () => {
    const section = viewsSection({
      days: [],
      paths: [],
      range: "30d",
      today: TODAY,
    });
    expect(section.status).toBe("empty");
    expect(section.total).toBe(0);
  });
});

describe("sourcesSection", () => {
  it("declines to break down a sample too small to mean anything", () => {
    const section = sourcesSection({
      domains: [{ domain: "bsky.app", views: 2 }],
      total: MIN_VIEWS_FOR_SOURCES - 1,
    });
    expect(section.status).toBe("insufficient_history");
    expect(section.buckets).toBeUndefined();
  });

  it("reports empty when there were no views at all", () => {
    expect(sourcesSection({ domains: [], total: 0 }).status).toBe("empty");
  });

  it("buckets against the authoritative total once there's enough traffic", () => {
    const section = sourcesSection({
      domains: [
        { domain: "bsky.app", views: 60 },
        { domain: null, views: 20 },
      ],
      total: 100,
    });
    expect(section.status).toBe("ok");
    expect(section.total).toBe(100);
    expect(section.buckets?.reduce((n, b) => n + b.views, 0)).toBe(100);
  });
});

describe("followersSection", () => {
  const window = { from: "2026-07-01", to: TODAY };

  it("reports empty when nothing was ever sampled", () => {
    expect(
      followersSection({ series: snapshotSeries([], window) }).status,
    ).toBe("empty");
  });

  it("renders the value but withholds the trend on a single reading", () => {
    const section = followersSection({
      series: snapshotSeries([{ day: "2026-07-30", followers: 1204 }], window),
    });
    expect(section.status).toBe("insufficient_history");
    expect(section.current).toBe(1204);
    expect(section.net).toBeUndefined();
    expect(section.series).toBeUndefined();
  });

  it("reports the net change and the unsampled days once there's a trend", () => {
    const section = followersSection({
      series: snapshotSeries(
        [
          { day: "2026-07-01", followers: 1166 },
          { day: "2026-07-03", followers: 1204 },
        ],
        window,
      ),
    });
    expect(section.status).toBe("ok");
    expect(section.current).toBe(1204);
    expect(section.net).toBe(38);
    expect(section.missingDays).toBe(1);
    expect(section.since).toBe("2026-07-01");
    expect(section.series).toEqual([
      { day: "2026-07-01", followers: 1166 },
      { day: "2026-07-03", followers: 1204 },
    ]);
  });

  it("reports a real decline honestly", () => {
    const section = followersSection({
      series: snapshotSeries(
        [
          { day: "2026-07-01", followers: 1204 },
          { day: "2026-07-02", followers: 1198 },
        ],
        window,
      ),
    });
    expect(section.net).toBe(-6);
  });
});

const POST = (rkey: string, suffix: string) => ({
  rkey,
  uri: `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/${suffix}`,
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  postRkey: suffix,
});

describe("engagementSection", () => {
  it("sums the counts and reports the denominator it summed over", () => {
    const a = POST("doc-a", "aaa");
    const b = POST("doc-b", "bbb");
    const section = engagementSection({
      announced: [a, b],
      byUri: new Map([
        [
          a.uri,
          { likeCount: 112, repostCount: 38, quoteCount: 9, replyCount: 14 },
        ],
        [
          b.uri,
          { likeCount: 64, repostCount: 21, quoteCount: 6, replyCount: 9 },
        ],
      ]),
      requested: 2,
      answered: 2,
      unannouncedCount: 3,
    });
    expect(section.status).toBe("ok");
    expect(section.totals).toEqual({
      likes: 176,
      reposts: 59,
      quotes: 15,
      replies: 23,
    });
    expect(section.countedPosts).toBe(2);
    expect(section.requestedPosts).toBe(2);
    expect(section.unannouncedCount).toBe(3);
  });

  it("keeps an absent count as null — absent is not zero", () => {
    const a = POST("doc-a", "aaa");
    const section = engagementSection({
      announced: [a],
      // The counts are optional in the lexicon; only likes came back.
      byUri: new Map([[a.uri, { likeCount: 5 }]]),
      requested: 1,
      answered: 1,
      unannouncedCount: 0,
    });
    expect(section.posts?.[0]).toMatchObject({
      likes: 5,
      reposts: null,
      quotes: null,
      replies: null,
    });
  });

  it("keeps a vanished announcement as a row and says so", () => {
    const a = POST("doc-a", "aaa");
    const section = engagementSection({
      announced: [a],
      byUri: new Map([[a.uri, "gone" as const]]),
      requested: 1,
      answered: 1,
      unannouncedCount: 0,
    });
    // Silently omitting the row would read as a bug and would leave a dropped
    // number unexplained.
    expect(section.posts).toHaveLength(1);
    expect(section.posts?.[0]).toMatchObject({ gone: true, likes: null });
    expect(section.totals).toEqual({
      likes: 0,
      reposts: 0,
      quotes: 0,
      replies: 0,
    });
    expect(section.countedPosts).toBe(0);
  });

  it("reports a partial answer as partial, never as a total", () => {
    const a = POST("doc-a", "aaa");
    const b = POST("doc-b", "bbb");
    const section = engagementSection({
      announced: [a, b],
      // b's batch failed: absent from the map, distinct from present-but-gone.
      byUri: new Map([[a.uri, { likeCount: 10 }]]),
      requested: 2,
      answered: 1,
      unannouncedCount: 0,
    });
    expect(section.countedPosts).toBe(1);
    expect(section.requestedPosts).toBe(2);
    expect(section.posts).toHaveLength(2);
    expect(section.totals?.likes).toBe(10);
  });

  it("reports unavailable only when every batch failed", () => {
    const a = POST("doc-a", "aaa");
    const section = engagementSection({
      announced: [a],
      byUri: new Map(),
      requested: 1,
      answered: 0,
      unannouncedCount: 2,
    });
    expect(section.status).toBe("unavailable");
    expect(section.totals).toBeUndefined();
    // The unannounced count is still true and still useful.
    expect(section.unannouncedCount).toBe(2);
  });

  it("reports nothing-announced as empty, with a count and no zero rows", () => {
    const section = engagementSection({
      announced: [],
      byUri: new Map(),
      requested: 0,
      answered: 0,
      unannouncedCount: 4,
    });
    expect(section.status).toBe("empty");
    expect(section.posts).toBeUndefined();
    expect(section.unannouncedCount).toBe(4);
  });

  it("orders rows by conversation, with unknowns last rather than first", () => {
    const a = POST("quiet", "aaa");
    const b = POST("loud", "bbb");
    const c = POST("unknown", "ccc");
    const section = engagementSection({
      announced: [a, b, c],
      byUri: new Map([
        [a.uri, { likeCount: 1 }],
        [b.uri, { likeCount: 90 }],
      ]),
      requested: 3,
      answered: 2,
      unannouncedCount: 0,
    });
    expect(section.posts?.map((p) => p.rkey)).toEqual([
      "loud",
      "quiet",
      "unknown",
    ]);
  });
});

/**
 * Which statuses are worth waking someone for.
 *
 * The easy mistake here is noise, not silence: three of the five non-ok
 * statuses are correct answers rather than faults, and reporting them would
 * fire on every dev request forever — at which point nobody reads the signal
 * and a genuinely dead upstream hides in it.
 */
describe("isDegraded — a fault, or just an answer", () => {
  it("treats an unusable upstream as a fault", () => {
    expect(isDegraded("unavailable")).toBe(true);
  });

  it("treats a working section as no fault", () => {
    expect(isDegraded("ok")).toBe(false);
  });

  it("does not report the states that are working as designed", () => {
    // not_configured: no key in this environment, permanent and correct.
    // insufficient_history: not collecting long enough yet — fixes itself.
    // empty: the upstream answered, and the answer is "nothing yet". Calling
    // that a fault is the same error as rendering it as a zero.
    for (const status of [
      "not_configured",
      "insufficient_history",
      "empty",
    ] as const) {
      expect(isDegraded(status)).toBe(false);
    }
  });

  it("covers every status the envelope can carry", () => {
    // If a status is added, this fails until someone decides which side of the
    // line it falls on — which is the decision that must not be made silently.
    const all: SectionStatus[] = [
      "ok",
      "unavailable",
      "not_configured",
      "insufficient_history",
      "empty",
    ];
    expect(all.filter(isDegraded)).toEqual(["unavailable"]);
  });
});
