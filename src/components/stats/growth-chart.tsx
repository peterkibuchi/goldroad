/**
 * "Views over time" / "Followers over time" — the section that turns a number
 * into a shape, and the states it has to survive on the way there.
 *
 * The plot is loaded on demand (see ./chart-plot); everything a reader needs to
 * understand the chart is here, in HTML, around it: the heading, the series
 * toggle, the captions that state what the line does and doesn't claim, and a
 * real data table.
 *
 * THE TABLE IS NOT A HIDDEN FALLBACK. "View as table" is a visible, focusable
 * disclosure any reader can open, and it is also the thing that makes the
 * numbers copy-pasteable into a spreadsheet. It lists only days that were
 * actually sampled — never an interpolated row.
 */
import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { densifySeries, seriesSummary } from "~/lib/chart-series";
import type { StatsRange } from "~/lib/stats";
import type { StatsEnvelope } from "~/lib/stats-sections";
import { cn } from "~/lib/utils";
import type { ChartSeriesKind } from "./chart-plot";
import {
  formatCount,
  formatDay,
  formatDayWithYear,
  LoadingRegion,
  QuietLine,
  SectionHeading,
  SkeletonBar,
} from "./shared";

const ChartPlot = lazy(() => import("./chart-plot"));

const SERIES: ReadonlyArray<{ kind: ChartSeriesKind; label: string }> = [
  { kind: "views", label: "Views" },
  { kind: "followers", label: "Followers" },
];

/** Same ink-fill vocabulary as the range picker: selection is structure. */
function SeriesToggle({
  series,
  onChange,
}: {
  series: ChartSeriesKind;
  onChange: (series: ChartSeriesKind) => void;
}) {
  return (
    <fieldset className="flex divide-x divide-ink border border-ink">
      <legend className="sr-only">Choose what the chart shows</legend>
      {SERIES.map((option) => {
        const isActive = option.kind === series;
        return (
          <button
            aria-pressed={isActive}
            className={cn(
              "inline-flex min-h-9 cursor-pointer items-center px-3 font-display text-xs transition-colors focus-visible:-outline-offset-2",
              isActive
                ? "bg-ink font-bold text-paper"
                : "text-ink-soft hover:bg-ink/5 hover:text-ink",
            )}
            key={option.kind}
            onClick={() => onChange(option.kind)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** A skeleton at the chart's exact height. The heading and the toggle are real
 * from the first paint, so nothing below the chart moves when it arrives. */
function PlotSkeleton() {
  return (
    <LoadingRegion label="Loading the chart…">
      <div className="mt-4 h-56 border-rule border-b sm:h-64">
        <SkeletonBar className="mt-16 h-px w-full" />
        <SkeletonBar className="mt-14 h-px w-full" />
        <SkeletonBar className="mt-14 h-px w-full" />
      </div>
    </LoadingRegion>
  );
}

/** A bordered panel with a sentence, instead of an axis frame with one dot in
 * it. An empty grid reads as broken; a sentence reads as early. */
function EarlyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 border border-rule px-4 py-6 sm:px-6">
      <p className="max-w-[46ch] font-display text-ink text-sm leading-relaxed">
        {children}
      </p>
    </div>
  );
}

function DataTable({
  rows,
  caption,
  valueLabel,
}: {
  rows: Array<{ day: string; value: number }>;
  caption: string;
  valueLabel: string;
}) {
  return (
    <details className="mt-3">
      <summary className="inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-xs underline underline-offset-2 transition-colors hover:text-ink">
        View as table
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto border border-rule">
        <table className="w-full font-display text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-ink border-b">
              <th
                className="px-3 py-2 text-left font-semibold text-ink-soft text-xs uppercase tracking-[0.06em]"
                scope="col"
              >
                Day
              </th>
              <th
                className="px-3 py-2 text-right font-semibold text-ink-soft text-xs uppercase tracking-[0.06em]"
                scope="col"
              >
                {valueLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-rule border-b last:border-0" key={row.day}>
                <th
                  className="px-3 py-1.5 text-left font-normal text-ink-soft"
                  scope="row"
                >
                  <time dateTime={row.day}>{formatDayWithYear(row.day)}</time>
                </th>
                <td className="px-3 py-1.5 text-right text-ink tabular-nums">
                  {formatCount(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function GrowthChart({
  metrics,
  range,
  series,
  onSeriesChange,
}: {
  metrics: StatsEnvelope | null;
  range: StatsRange;
  series: ChartSeriesKind;
  onSeriesChange: (series: ChartSeriesKind) => void;
}) {
  const heading =
    series === "views" ? "Views over time" : "Followers over time";
  const section = series === "views" ? metrics?.views : metrics?.followers;

  const body = (() => {
    if (metrics === null) return <PlotSkeleton />;
    if (section?.status === "not_configured")
      return (
        <EarlyPanel>
          Reader counts aren't switched on for this site — your follower chart
          still works.
        </EarlyPanel>
      );
    if (section?.status === "unavailable")
      return (
        <EarlyPanel>
          This chart couldn't be loaded right now. Refresh to try again.
        </EarlyPanel>
      );

    const window = chartWindow(metrics, series);
    if (window === null) {
      // The one snapshot a brand-new writer has is a number, not a trend. Naming
      // the day it was taken makes the chart's left edge legible as OUR start
      // rather than as the writer's.
      const firstReading =
        metrics.followers.since ?? metrics.followers.currentDay;
      return (
        <EarlyPanel>
          {series === "views" ? (
            "No views yet. Your chart appears once readers start arriving."
          ) : firstReading ? (
            <>
              Your chart starts here. We took your first follower reading on{" "}
              {formatDayWithYear(firstReading)} — come back tomorrow for the
              first line.
            </>
          ) : (
            "Your chart starts here. Your follower count is read once a day — come back tomorrow for the first line."
          )}
        </EarlyPanel>
      );
    }

    const points = densifySeries(window.rows, {
      from: window.from,
      to: window.to,
      // Views: a day the query returned nothing for genuinely had no pageviews.
      // Followers: a day with no row means no reading was taken.
      missing: series === "views" ? "zero" : "gap",
    });
    const summary = seriesSummary(points);
    if (summary === null || summary.insufficient)
      return (
        <EarlyPanel>
          {series === "views"
            ? "One day of views so far. Your chart appears once there are two."
            : `Your chart starts here. We took your first follower reading on ${
                summary === null
                  ? "day one"
                  : formatDayWithYear(summary.firstDay)
              } — come back tomorrow for the first line.`}
        </EarlyPanel>
      );

    const valueLabel = series === "views" ? "Views" : "Followers";
    const ariaSummary = [
      `${valueLabel} per day from ${formatDayWithYear(summary.firstDay)} to ${formatDayWithYear(summary.lastDay)}.`,
      series === "views"
        ? `${formatCount(summary.total)} in total.`
        : `${summary.net >= 0 ? "Up" : "Down"} ${formatCount(Math.abs(summary.net))} over the range.`,
      `Lowest ${formatCount(summary.lowest.value)} on ${formatDay(summary.lowest.day)}, highest ${formatCount(summary.highest.value)} on ${formatDay(summary.highest.day)}.`,
    ].join(" ");

    return (
      <>
        <div className="mt-4">
          <ClientOnly fallback={<PlotSkeleton />}>
            <Suspense fallback={<PlotSkeleton />}>
              <ChartPlot kind={series} points={points} />
            </Suspense>
          </ClientOnly>
        </div>
        <p className="sr-only">{ariaSummary}</p>
        {series === "views" && summary.total === 0 && (
          <QuietLine className="mt-2">
            No views in this range — the line sits on zero.
          </QuietLine>
        )}
        {summary.missingDays > 0 && (
          <QuietLine className="mt-2">
            No reading was taken on {summary.missingDays}{" "}
            {summary.missingDays === 1 ? "day" : "days"} in this range, so the
            line breaks there.
          </QuietLine>
        )}
        {range === "all" && (
          <QuietLine className="mt-2">
            Since {formatDayWithYear(summary.firstDay)} — as far back as we can
            see.
          </QuietLine>
        )}
        <DataTable
          caption={`${valueLabel} by day, ${formatDayWithYear(summary.firstDay)} to ${formatDayWithYear(summary.lastDay)}`}
          rows={points.filter(
            (point): point is { day: string; value: number } =>
              point.value !== null,
          )}
          valueLabel={valueLabel}
        />
      </>
    );
  })();

  return (
    <section aria-labelledby="chart-heading" className="mt-10">
      <SectionHeading
        action={<SeriesToggle onChange={onSeriesChange} series={series} />}
        id="chart-heading"
      >
        {heading}
      </SectionHeading>
      {body}
    </section>
  );
}

/** The rows and window one series plots, or null when there's nothing to plot. */
function chartWindow(
  metrics: StatsEnvelope,
  series: ChartSeriesKind,
): {
  rows: Array<{ day: string; value: number }>;
  from: string;
  to: string;
} | null {
  if (series === "views") {
    const rows = metrics.views.series;
    if (!rows || rows.length === 0) return null;
    return {
      rows: rows.map((row) => ({ day: row.day, value: row.views })),
      from: rows[0].day,
      to: rows[rows.length - 1].day,
    };
  }
  const rows = metrics.followers.series;
  if (!rows || rows.length === 0) return null;
  return {
    rows: rows.map((row) => ({ day: row.day, value: row.followers })),
    from: rows[0].day,
    to: rows[rows.length - 1].day,
  };
}
