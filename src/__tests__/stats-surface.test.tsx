import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EngagementPanel } from "#/components/stats/engagement-panel";
import { GrowthChart } from "#/components/stats/growth-chart";
import { PostTable } from "#/components/stats/post-table";
import { RangePicker } from "#/components/stats/range-picker";
import { StatCards } from "#/components/stats/stat-cards";
import { TrafficSources } from "#/components/stats/traffic-sources";
import type { PostMetrics } from "#/lib/stats-posts";
import { sortPostMetrics } from "#/lib/stats-posts";
import type { EngagementSection, StatsEnvelope } from "#/lib/stats-sections";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const IDENT = "writer.example";
const postHref = (rkey: string) => `/@${IDENT}/${rkey}`;
const noop = () => {};

function envelope(overrides: Partial<StatsEnvelope> = {}): StatsEnvelope {
  return {
    range: "30d",
    generatedAt: "2026-07-30T09:00:00.000Z",
    views: { status: "empty", total: 0 },
    sources: { status: "empty", total: 0 },
    followers: { status: "empty" },
    engagement: { status: "empty", unannouncedCount: 0 },
    ...overrides,
  };
}

describe("StatCards — loading", () => {
  it("shows real labels immediately, so the page's shape never jumps", () => {
    const { container } = render(
      <StatCards
        metrics={null}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    screen.getByText("Views");
    screen.getByText("Followers on Bluesky");
    screen.getByText("Likes, reposts, replies");
    screen.getByText("Most read");
    // Skeletons, never spinners — and they stand down under reduced motion.
    const pulses = container.querySelectorAll(".animate-pulse");
    expect(pulses.length).toBeGreaterThan(0);
    for (const pulse of pulses)
      expect(pulse.className).toContain("motion-reduce:animate-none");
  });
});

describe("StatCards — the comparison is only shown when it's honest", () => {
  it("renders a delta when the server says the windows are comparable", () => {
    render(
      <StatCards
        metrics={envelope({
          views: {
            status: "ok",
            total: 4812,
            previousTotal: 4296,
            comparable: true,
          },
        })}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    screen.getByText("4,812");
    screen.getByText(/12% vs previous 30 days/);
  });

  it("says what's true instead when there's no comparable window", () => {
    render(
      <StatCards
        metrics={envelope({
          views: { status: "ok", total: 120, comparable: false },
        })}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    screen.getByText(/Your first 30 days/);
    expect(screen.queryByText(/vs previous/)).toBeNull();
  });

  it("names a flat period rather than reporting 0%", () => {
    render(
      <StatCards
        metrics={envelope({
          views: {
            status: "ok",
            total: 100,
            previousTotal: 100,
            comparable: true,
          },
        })}
        postHref={postHref}
        range="7d"
        topPost={null}
      />,
    );
    screen.getByText(/Level with the previous 7 days/);
  });

  it("spends no colour on a decline — a dip is a normal week, not an alarm", () => {
    const { container } = render(
      <StatCards
        metrics={envelope({
          views: {
            status: "ok",
            total: 50,
            previousTotal: 100,
            comparable: true,
          },
        })}
        postHref={postHref}
        range="7d"
        topPost={null}
      />,
    );
    screen.getByText(/50% vs previous 7 days/);
    // No green, no red, and no vermillion: the accent belongs to the chart.
    expect(container.innerHTML).not.toMatch(/text-(red|green|spot)/);
  });
});

describe("StatCards — absence, failure and the unconfigured instance", () => {
  it("shows a dash and a sentence where absence is the truth, never a 0", () => {
    render(
      <StatCards
        metrics={envelope()}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    screen.getByText("No views in this range yet.");
    expect(screen.queryByText("0")).toBeNull();
  });

  it("fails one card at a time", () => {
    render(
      <StatCards
        metrics={envelope({
          views: { status: "unavailable" },
          followers: {
            status: "ok",
            current: 1204,
            net: 38,
            currentDay: "2026-07-30",
          },
        })}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    // The dead card says so; its neighbour renders normally.
    expect(
      screen.getAllByText(/This number couldn't be loaded right now/),
    ).toHaveLength(2); // views + most read, both fed by the same section
    screen.getByText("1,204");
    screen.getByText("+38 in 30 days");
  });

  it("keeps followers and Bluesky counts working with no analytics keys", () => {
    render(
      <StatCards
        metrics={envelope({
          views: { status: "not_configured" },
          sources: { status: "not_configured" },
          followers: {
            status: "ok",
            current: 900,
            net: -6,
            currentDay: "2026-07-30",
          },
          engagement: {
            status: "ok",
            totals: { likes: 10, reposts: 2, quotes: 1, replies: 3 },
            countedPosts: 2,
          },
        })}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    expect(
      screen.getAllByText("Reader counts aren't switched on for this site."),
    ).toHaveLength(2);
    screen.getByText("900");
    screen.getByText("6 fewer in 30 days");
    // Likes + reposts + replies — the label names exactly what the number sums.
    screen.getByText("15");
  });

  it("says the trend starts tomorrow on a single follower reading", () => {
    render(
      <StatCards
        metrics={envelope({
          followers: {
            status: "insufficient_history",
            current: 1204,
            currentDay: "2026-07-30",
          },
        })}
        postHref={postHref}
        range="30d"
        topPost={null}
      />,
    );
    screen.getByText("1,204");
    screen.getByText(/First reading today — your trend starts tomorrow/);
  });

  it("links the most-read post by its title", () => {
    render(
      <StatCards
        metrics={envelope({ views: { status: "ok", total: 1930 } })}
        postHref={postHref}
        range="30d"
        topPost={{ rkey: "aaa", title: "Ten Thousand Ships", views: 1930 }}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: /Ten Thousand Ships/ })
        .getAttribute("href"),
    ).toBe(`/@${IDENT}/aaa`);
    screen.getByText(/1,930 views in 30 days/);
  });
});

describe("RangePicker", () => {
  it("is a labelled group of real buttons with the selection announced", () => {
    render(<RangePicker onChange={noop} range="30d" />);
    const group = screen.getByRole("group", { name: "Time range" });
    const active = within(group).getByRole("button", { name: "30 days" });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(group)
        .getByRole("button", { name: "7 days" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    // Selection is an ink fill — never the page's one accent.
    expect(active.className).toContain("bg-ink");
    expect(active.className).not.toContain("spot");
  });

  it("keeps a 44px touch target on every segment", () => {
    render(<RangePicker onChange={noop} range="7d" />);
    for (const button of screen.getAllByRole("button"))
      expect(button.className).toContain("min-h-11");
  });
});

describe("GrowthChart", () => {
  it("keeps the heading and the series toggle real while numbers load", () => {
    render(
      <GrowthChart
        metrics={null}
        onSeriesChange={noop}
        range="30d"
        series="views"
      />,
    );
    screen.getByText("Views over time");
    const group = screen.getByRole("group", {
      name: "Choose what the chart shows",
    });
    within(group).getByRole("button", { name: "Views" });
    within(group).getByRole("button", { name: "Followers" });
  });

  it("replaces an empty plot frame with a sentence when there's no trend yet", () => {
    render(
      <GrowthChart
        metrics={envelope({
          followers: {
            status: "insufficient_history",
            current: 1204,
            currentDay: "2026-07-30",
            since: "2026-07-30",
          },
        })}
        onSeriesChange={noop}
        range="30d"
        series="followers"
      />,
    );
    // An empty grid with one dot in it reads as broken; a sentence reads as early.
    screen.getByText(/Your chart starts here/);
    screen.getByText(/Jul 30, 2026/);
    expect(screen.queryByText("View as table")).toBeNull();
  });

  it("offers the data table and states how many days went unsampled", () => {
    render(
      <GrowthChart
        metrics={envelope({
          followers: {
            status: "ok",
            current: 1240,
            currentDay: "2026-07-04",
            since: "2026-07-01",
            net: 40,
            missingDays: 2,
            series: [
              { day: "2026-07-01", followers: 1200 },
              { day: "2026-07-04", followers: 1240 },
            ],
          },
        })}
        onSeriesChange={noop}
        range="30d"
        series="followers"
      />,
    );
    screen.getByText(/No reading was taken on 2 days in this range/);
    const table = screen.getByRole("table");
    // Only real samples are listed — never an interpolated row.
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    within(table).getByText("1,200");
    within(table).getByText("1,240");
    expect(within(table).queryByText("1,220")).toBeNull();
  });

  it("carries a screen-reader summary with the series' real numbers", () => {
    render(
      <GrowthChart
        metrics={envelope({
          views: {
            status: "ok",
            total: 12,
            series: [
              { day: "2026-07-01", views: 4 },
              { day: "2026-07-02", views: 8 },
            ],
          },
        })}
        onSeriesChange={noop}
        range="30d"
        series="views"
      />,
    );
    screen.getByText(/Views per day from Jul 1, 2026 to Jul 2, 2026/);
    screen.getByText(/Lowest 4 on Jul 1, highest 8 on Jul 2/);
  });

  it("keeps the toggle available when one series is unavailable", () => {
    render(
      <GrowthChart
        metrics={envelope({ views: { status: "unavailable" } })}
        onSeriesChange={noop}
        range="30d"
        series="views"
      />,
    );
    screen.getByText(/This chart couldn't be loaded right now/);
    // The other series may be perfectly fine.
    screen.getByRole("button", { name: "Followers" });
  });
});

describe("TrafficSources", () => {
  it("declines to break down a sample too small to mean anything", () => {
    render(
      <TrafficSources sources={{ status: "insufficient_history", total: 3 }} />,
    );
    screen.getByText(/Too few views to break down yet/);
  });

  it("draws bucket rows with percentages, and always states the limitation", () => {
    render(
      <TrafficSources
        sources={{
          status: "ok",
          total: 100,
          buckets: [
            { bucket: "bluesky", views: 61 },
            { bucket: "direct", views: 24 },
            { bucket: "search", views: 9 },
            { bucket: "other", views: 6 },
          ],
          topOtherDomains: [{ domain: "news.ycombinator.com", views: 4 }],
        }}
      />,
    );
    screen.getByText("Bluesky");
    screen.getByText("Direct or unknown");
    screen.getByText("61%");
    // The limitation line is required, not optional.
    screen.getByText(/What this can't tell you/);
    screen.getByText(/your Bluesky share is a floor, not a total/);
    // The named domains behind "Other sites" are the interesting part.
    screen.getByText("Which sites");
    screen.getByText("news.ycombinator.com");
  });

  it("is readable without its bars, which are hidden from assistive tech", () => {
    const { container } = render(
      <TrafficSources
        sources={{
          status: "ok",
          total: 10,
          buckets: [{ bucket: "bluesky", views: 10 }],
        }}
      />,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(1);
    screen.getByText("Bluesky");
    screen.getByText("100%");
  });
});

const ENGAGEMENT_OK: EngagementSection = {
  status: "ok",
  totals: { likes: 248, reposts: 74, quotes: 31, replies: 33 },
  countedPosts: 2,
  requestedPosts: 2,
  unannouncedCount: 3,
  posts: [],
};

const ROW = {
  rkey: "aaa",
  title: "Ten Thousand Ships",
  date: "July 1, 2026",
  publishedAt: "2026-07-01T00:00:00.000Z",
  likes: 112,
  reposts: 38,
  quotes: 9,
  replies: 14,
  gone: false,
  threadUrl: "https://bsky.app/profile/did:plc:aaaa/post/xxx",
};

describe("EngagementPanel — the differentiator", () => {
  it("makes the provenance claim in plain words and links into the thread", () => {
    render(
      <EngagementPanel
        engagement={ENGAGEMENT_OK}
        postHref={postHref}
        rows={[ROW]}
      />,
    );
    screen.getByText(
      /the real likes, reposts and replies your posts earned on Bluesky/,
    );
    const link = screen.getByRole("link", { name: /14 replies/ });
    expect(link.getAttribute("href")).toBe(ROW.threadUrl);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("always carries the denominator with the aggregate", () => {
    render(
      <EngagementPanel
        engagement={ENGAGEMENT_OK}
        postHref={postHref}
        rows={[ROW]}
      />,
    );
    screen.getByText(/across 2 posts you shared to Bluesky/);
  });

  it("reports unannounced posts as a count, never as rows of zeros", () => {
    render(
      <EngagementPanel
        engagement={ENGAGEMENT_OK}
        postHref={postHref}
        rows={[ROW]}
      />,
    );
    screen.getByText(/3 posts haven't been shared to Bluesky yet/);
    // Exactly one post row exists — the announced one.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("teaches instead of erroring when nothing has been shared yet", () => {
    render(
      <EngagementPanel
        engagement={{ status: "empty", unannouncedCount: 4 }}
        postHref={postHref}
        rows={[]}
      />,
    );
    screen.getByText(
      /Announcing a post puts it in front of your Bluesky followers/,
    );
    expect(
      screen
        .getByRole("link", { name: /Announce a post from Posts/ })
        .getAttribute("href"),
    ).toBe("/dashboard");
  });

  it("draws a dash for an absent count and explains what a dash means", () => {
    render(
      <EngagementPanel
        engagement={ENGAGEMENT_OK}
        postHref={postHref}
        rows={[{ ...ROW, quotes: null }]}
      />,
    );
    screen.getByText(/A dash means we have no number for it, not zero/);
    expect(screen.getAllByText("no number").length).toBeGreaterThan(0);
  });

  it("keeps a vanished announcement visible and says what happened", () => {
    render(
      <EngagementPanel
        engagement={ENGAGEMENT_OK}
        postHref={postHref}
        rows={[
          {
            ...ROW,
            gone: true,
            likes: null,
            reposts: null,
            quotes: null,
            replies: null,
          },
        ]}
      />,
    );
    screen.getByText("Ten Thousand Ships");
    screen.getByText(/isn't on Bluesky anymore/);
  });

  it("says what a partial answer was computed over", () => {
    render(
      <EngagementPanel
        engagement={{ ...ENGAGEMENT_OK, countedPosts: 18, requestedPosts: 25 }}
        postHref={postHref}
        rows={[ROW]}
      />,
    );
    screen.getByText(/Counted across 18 of your 25 shared posts/);
  });

  it("wears the page's only structural frame in weight, not colour", () => {
    const { container } = render(
      <EngagementPanel
        engagement={ENGAGEMENT_OK}
        postHref={postHref}
        rows={[ROW]}
      />,
    );
    const panel = container.querySelector("section");
    expect(panel?.className).toContain("border-2");
    expect(panel?.className).toContain("border-ink");
    expect(panel?.className).not.toContain("rounded");
    expect(panel?.className).not.toContain("shadow");
  });
});

function metric(
  overrides: Partial<PostMetrics> & { rkey: string },
): PostMetrics {
  return {
    title: `post ${overrides.rkey}`,
    publishedAt: "2026-07-01T00:00:00.000Z",
    date: "July 1, 2026",
    readingMinutes: 7,
    editable: true,
    announced: null,
    views: 100,
    likes: 5,
    reposts: 2,
    replies: 1,
    gone: false,
    ...overrides,
  };
}

describe("PostTable", () => {
  const rows = [
    metric({ rkey: "low", title: "quiet one", views: 5 }),
    metric({ rkey: "high", title: "loud one", views: 900 }),
    metric({ rkey: "none", title: "uncounted one", views: null }),
  ];

  it("renders titles, dates and reading time while the numbers are skeletons", () => {
    const { container } = render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading
        metricsUnavailable={false}
        onSortChange={noop}
        rows={rows}
        sort="date"
        truncated={false}
      />,
    );
    // The best loading state on the page, and free: real content, pending numbers.
    expect(screen.getAllByText("loud one").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
  });

  it("announces the sorted column to assistive tech", () => {
    render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading={false}
        metricsUnavailable={false}
        onSortChange={noop}
        rows={sortPostMetrics(rows, "views", "desc")}
        sort="views"
        truncated={false}
      />,
    );
    const header = screen
      .getByRole("button", { name: "Sort by Views" })
      .closest("th");
    expect(header?.getAttribute("aria-sort")).toBe("descending");
    expect(
      screen
        .getByRole("button", { name: "Sort by Likes" })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("none");
  });

  it("puts rows with no number last, in both directions", () => {
    for (const direction of ["asc", "desc"] as const) {
      cleanup();
      render(
        <PostTable
          direction={direction}
          ident={IDENT}
          loading={false}
          metricsUnavailable={false}
          onSortChange={noop}
          rows={sortPostMetrics(rows, "views", direction)}
          sort="views"
          truncated={false}
        />,
      );
      const bodyRows = within(screen.getByRole("table")).getAllByRole("row");
      // Header row first, so the last row is the last post.
      expect(bodyRows[bodyRows.length - 1].textContent).toContain(
        "uncounted one",
      );
    }
  });

  it("offers a labelled select as the mobile sort control", () => {
    render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading={false}
        metricsUnavailable={false}
        onSortChange={noop}
        rows={rows}
        sort="date"
        truncated={false}
      />,
    );
    const select = screen.getByRole("combobox", { name: /Sort by/ });
    expect(select).toHaveProperty("value", "date:desc");
  });

  it("degrades to the writer's own post list when both metric sources failed", () => {
    render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading={false}
        metricsUnavailable
        onSortChange={noop}
        rows={rows.map((row) =>
          metric({ ...row, views: null, likes: null, replies: null }),
        )}
        sort="date"
        truncated={false}
      />,
    );
    screen.getByText(/Your posts are here; the numbers couldn't be loaded/);
    expect(screen.getAllByText("loud one").length).toBeGreaterThan(0);
  });

  it("never presents a page as the whole archive", () => {
    render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading={false}
        metricsUnavailable={false}
        onSortChange={noop}
        rows={rows}
        sort="date"
        truncated
      />,
    );
    screen.getByText(/Showing your 200 most recent posts/);
  });

  it("marks a post written in another app, the way the posts list does", () => {
    render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading={false}
        metricsUnavailable={false}
        onSortChange={noop}
        rows={[metric({ rkey: "foreign", editable: false })]}
        sort="date"
        truncated={false}
      />,
    );
    expect(
      screen.getAllByText(/Written in another app/).length,
    ).toBeGreaterThan(0);
  });

  it("explains that a dash is not a zero", () => {
    render(
      <PostTable
        direction="desc"
        ident={IDENT}
        loading={false}
        metricsUnavailable={false}
        onSortChange={noop}
        rows={rows}
        sort="date"
        truncated={false}
      />,
    );
    screen.getByText(/A dash means we have no number, not zero/);
  });
});

describe("the surface refuses to gamify", () => {
  it("carries no streaks, badges, percentiles or growth nudges", () => {
    const { container } = render(
      <>
        <StatCards
          metrics={envelope({
            views: {
              status: "ok",
              total: 4812,
              previousTotal: 4296,
              comparable: true,
            },
            followers: {
              status: "ok",
              current: 1204,
              net: 38,
              currentDay: "2026-07-30",
            },
            engagement: {
              status: "ok",
              totals: { likes: 248, reposts: 74, quotes: 31, replies: 33 },
              countedPosts: 9,
            },
          })}
          postHref={postHref}
          range="30d"
          topPost={{ rkey: "aaa", title: "Ten Thousand Ships", views: 1930 }}
        />
        <EngagementPanel
          engagement={ENGAGEMENT_OK}
          postHref={postHref}
          rows={[ROW]}
        />
      </>,
    );
    const text = container.textContent ?? "";
    for (const word of [
      "streak",
      "badge",
      "level up",
      "top 1",
      "percentile",
      "leaderboard",
      "Keep it up",
      "goal",
    ])
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
  });
});
