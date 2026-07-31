import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { useEffect, useState } from "react";

import { formatDate } from "~/components/document-article";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import type { ChartSeriesKind } from "~/components/stats/chart-plot";
import {
  EngagementPanel,
  engagementRows,
} from "~/components/stats/engagement-panel";
import { GrowthChart } from "~/components/stats/growth-chart";
import { PostTable } from "~/components/stats/post-table";
import { RangePicker } from "~/components/stats/range-picker";
import { LINK_CLASS } from "~/components/stats/shared";
import { StatCards, type TopPost } from "~/components/stats/stat-cards";
import { TrafficSources } from "~/components/stats/traffic-sources";
import {
  listRecordPages,
  MAX_ARCHIVE_PAGES,
  resolveDidToHandle,
  resolveDidToPds,
  rkeyFromUri,
  type StandardDocument,
} from "~/lib/atproto";
import { announcedPostUri } from "~/lib/engagement";
import { readLiveSessionDid } from "~/lib/live-session";
import { parseStatsRange, type StatsRange } from "~/lib/stats";
import {
  approximateReadingMinutes,
  joinMetricsToRows,
  parseSortDirection,
  parseSortKey,
  pathFor,
  type SortDirection,
  type SortKey,
  type StatsPostRow,
  sortPostMetrics,
} from "~/lib/stats-posts";
import type { StatsEnvelope } from "~/lib/stats-sections";
import { env } from "cloudflare:workers";

/**
 * /stats — the analytics destination.
 *
 * It has its own route because it answers a different question on a different
 * clock. Posts answers "what have I got, and what do I do to it?" — daily, and
 * every element there is an affordance for acting on a specific post. Stats
 * answers "is this working, and where is it working?" — weekly, exploratory, and
 * arriving with no intent at all, which is why it needs the range controls,
 * comparisons, breakdowns and sorting that would make the Posts page worse at
 * its own job. Keeping them apart also means a slow analytics upstream can never
 * degrade the page a writer publishes from.
 *
 * READ-ONLY BY DESIGN. Nothing here edits, publishes or deletes: a writer should
 * never have to be careful clicking around their own numbers. The only outbound
 * actions are navigations — open a post, open a thread.
 *
 * NUMBERS ARE REPORTED, NEVER SCORED. No streaks, no badges, no percentiles, no
 * cross-writer comparison, no "post three more times this week". A writer having
 * a quiet month has to be able to open this page without being told they are
 * losing. The only forward-looking voice allowed is factual — "your trend starts
 * tomorrow" is a statement about our data, not a nudge about their behaviour.
 *
 * WHERE THE DATA COMES FROM. The loader reads the writer's own documents from
 * their data server, so titles, dates and reading times are on screen in the
 * first paint. Every number arrives afterwards from one client-side call to
 * /api/stats, which keeps a slow upstream off the page-load path entirely. The
 * range and sort live in the URL — shareable, restorable, survives the back
 * button — and deliberately do NOT re-run the loader.
 */

/** Characters of body text we're willing to look at per post, purely to size a
 * reading estimate. Bounded because this runs across a whole page of records
 * inside a request with a ten-millisecond CPU budget. */
const READING_SCAN_LIMIT = 200_000;

const getStats = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const did = await readLiveSessionDid(
    request,
    env.COOKIE_SECRET,
    drizzle(env.DB),
  );
  if (!did) return null;

  const handle = await resolveDidToHandle(did).catch(() => null);
  const pds = await resolveDidToPds(did).catch(() => null);
  const page = pds
    ? await listRecordPages<StandardDocument>(
        pds,
        did,
        "site.standard.document",
        { maxPages: MAX_ARCHIVE_PAGES },
      ).catch(() => null)
    : null;

  const rows: StatsPostRow[] | null =
    page === null
      ? null
      : page.records
          .flatMap((record) => {
            const rkey = rkeyFromUri(record.uri);
            if (!rkey) return [];
            const publishedAt =
              typeof record.value.publishedAt === "string"
                ? record.value.publishedAt
                : null;
            const announced = announcedPostUri(record.value.bskyPostRef);
            return [
              {
                rkey,
                title:
                  typeof record.value.title === "string" &&
                  record.value.title.trim() !== ""
                    ? record.value.title
                    : "(untitled)",
                publishedAt,
                date: formatDate(publishedAt ?? undefined),
                readingMinutes: approximateReadingMinutes(
                  typeof record.value.textContent === "string"
                    ? record.value.textContent.slice(0, READING_SCAN_LIMIT)
                    : undefined,
                ),
                editable: record.value.content == null,
                announced: announced
                  ? {
                      did: announced.did,
                      postRkey: announced.rkey,
                      uri: announced.uri,
                    }
                  : null,
              } satisfies StatsPostRow,
            ];
          })
          // Newest first, matching the posts list; the table's own sort takes
          // over from here.
          .sort(
            (a, b) =>
              Date.parse(b.publishedAt ?? "") -
                Date.parse(a.publishedAt ?? "") || (a.rkey < b.rkey ? 1 : -1),
          );

  return {
    ident: handle ?? did,
    // Document bodies are deliberately NOT part of this payload — the loader's
    // result is serialized into the page, and two hundred full posts would be
    // megabytes of HTML for numbers nobody reads.
    rows,
    truncated: page?.truncated ?? false,
  };
});

export const Route = createFileRoute("/stats")({
  /**
   * Frozen allowlists, every one of them. A stray or hostile query string must
   * never 400 a writer's own analytics page and must never reach a query — so
   * anything unrecognized falls back to the default silently.
   */
  validateSearch: (search: Record<string, unknown>) => ({
    range: parseStatsRange(search.range),
    series:
      search.series === "followers"
        ? ("followers" as const)
        : ("views" as const),
    sort: parseSortKey(search.sort),
    dir: parseSortDirection(search.dir),
  }),
  // Deliberately empty: changing the range, the series or the sort must never
  // re-read the writer's data server.
  loaderDeps: () => ({}),
  loader: async () => {
    const stats = await getStats();
    // Unauthed → /write, which renders the sign-in form (same as Posts),
    // carrying this page as the destination to come back to.
    if (!stats)
      throw redirect({ to: "/write", search: { returnTo: "/stats" } });
    return stats;
  },
  head: () => ({
    meta: [
      { title: "Stats — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: StatsPage,
});

type MetricsState =
  | { status: "loading" }
  | { status: "ready"; envelope: StatsEnvelope }
  | { status: "failed" };

/**
 * One call per (page load, range). No polling, no per-section requests, no
 * waterfall. Runs after hydration only, so server and client agree on the first
 * render and a slow upstream never holds up the page.
 */
function useStatsMetrics(range: StatsRange): MetricsState {
  const [state, setState] = useState<MetricsState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/stats?range=${encodeURIComponent(range)}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<StatsEnvelope>)
          : Promise.reject(new Error(String(res.status))),
      )
      .then((envelope) => {
        if (!cancelled) setState({ status: "ready", envelope });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [range]);
  return state;
}

/** The whole surface replaced by one panel. Rendering an empty analytics
 * dashboard to someone with nothing published is a page that says "you have
 * failed at something you haven't started". */
function FirstRun() {
  return (
    <div className="mt-10 border-2 border-ink p-6 sm:p-8">
      <h2 className="font-black font-display text-ink text-xl tracking-tight">
        Nothing to measure yet.
      </h2>
      <p className="mt-3 max-w-[52ch] text-ink-soft leading-relaxed">
        Publish your first post and this page fills in: how many people read it,
        where they came from, and the conversation it starts on Bluesky.
      </p>
      <a
        className="mt-6 inline-flex min-h-11 items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
        href="/write"
      >
        Write your first post
      </a>
      <p className="mt-4 font-display text-ink-soft text-sm">
        Coming from Substack or another platform?{" "}
        <a className={LINK_CLASS} href="/import">
          Import your writing
        </a>{" "}
        — posts arrive as private drafts.
      </p>
    </div>
  );
}

function StatsPage() {
  const { ident, rows, truncated } = Route.useLoaderData();
  const { range, series, sort, dir } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const metrics = useStatsMetrics(range);

  const envelope = metrics.status === "ready" ? metrics.envelope : null;
  const postHref = (rkey: string) =>
    `/@${encodeURIComponent(ident)}/${encodeURIComponent(rkey)}`;

  const setSearch = (next: {
    range?: StatsRange;
    series?: ChartSeriesKind;
    sort?: SortKey;
    dir?: SortDirection;
  }) => {
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...next }) });
  };

  const loaderRows = rows ?? [];

  // The most-read post, resolved against the writer's own rows so the card can
  // show a title rather than a URL path.
  const topPost: TopPost | null = (() => {
    const paths = envelope?.views.paths;
    if (!paths || paths.length === 0) return null;
    let best: TopPost | null = null;
    for (const row of loaderRows) {
      const views = paths.find(
        (p) => p.path === pathFor(ident, row.rkey),
      )?.views;
      if (views === undefined) continue;
      if (best === null || views > best.views)
        best = { rkey: row.rkey, title: row.title, views };
    }
    return best;
  })();

  const metricsUnavailable =
    envelope !== null &&
    envelope.views.status !== "ok" &&
    envelope.engagement.status !== "ok";

  const tableRows = sortPostMetrics(
    joinMetricsToRows({
      rows: loaderRows,
      paths: envelope?.views.paths ?? null,
      engagement: envelope?.engagement.posts ?? null,
      ident,
    }),
    sort,
    dir,
  );

  const titles = new Map(
    loaderRows.map((row) => [
      row.rkey,
      { title: row.title, publishedAt: row.publishedAt, date: row.date },
    ]),
  );

  const isFirstRun = rows !== null && rows.length === 0;

  return (
    <AppShell header={{ variant: "signed-in", ident, active: "stats" }}>
      <main className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div>
            <h1 className="font-black font-display text-3xl text-ink tracking-tight">
              Stats
            </h1>
            <p className="mt-1 text-ink-soft">
              How your writing is travelling.
            </p>
          </div>
          {/* The picker stays fully interactive even when a section has less
              history than the window asks for — never disable a control to
              teach a fact; the section says so itself. */}
          <RangePicker
            onChange={(next) => setSearch({ range: next })}
            range={range}
          />
        </div>

        {rows === null && (
          // Ink, not the alert tone the Posts page uses for the same read. Two
          // reasons: the page's single accent moment belongs to the chart, and a
          // spot-coloured notice can appear right alongside it (the metrics
          // arrive on their own call, so a failed document read doesn't stop the
          // chart from rendering). And nothing here is destructive or urgent —
          // it's a fact about our plumbing that a refresh fixes, in the same
          // quiet voice every other "couldn't load" line on this surface uses.
          <Notice tone="info">
            Your posts couldn't be loaded right now — your data server may be
            briefly unreachable. They're safe in your repo; refresh to try
            again.
          </Notice>
        )}

        {metrics.status === "failed" && (
          <Notice tone="info">
            Your numbers couldn't be loaded right now. Refresh to try again.
          </Notice>
        )}

        {isFirstRun ? (
          <FirstRun />
        ) : (
          <>
            <StatCards
              metrics={envelope}
              postHref={postHref}
              range={range}
              topPost={topPost}
            />

            <GrowthChart
              metrics={envelope}
              onSeriesChange={(next) => setSearch({ series: next })}
              range={range}
              series={series}
            />

            <TrafficSources sources={envelope?.sources ?? null} />

            <EngagementPanel
              engagement={envelope?.engagement ?? null}
              postHref={postHref}
              rows={
                envelope === null
                  ? []
                  : engagementRows(envelope.engagement, titles)
              }
            />

            {loaderRows.length > 0 && (
              <PostTable
                direction={dir}
                ident={ident}
                loading={envelope === null}
                metricsUnavailable={metricsUnavailable}
                onSortChange={(nextSort, nextDir) =>
                  setSearch({ dir: nextDir, sort: nextSort })
                }
                rows={tableRows}
                sort={sort}
                truncated={truncated}
              />
            )}

            <p className="mt-10 border-rule border-t pt-4 font-display text-ink-soft text-xs leading-relaxed">
              {envelope
                ? `Updated ${new Date(envelope.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. `
                : ""}
              Days run midnight to midnight, UTC. Reader counts are approximate
              — we don't follow readers around the web, so some are never
              counted.
            </p>
          </>
        )}
      </main>
    </AppShell>
  );
}
