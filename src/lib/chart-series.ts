/**
 * Series preparation for the growth chart.
 *
 * The one rule this module exists to enforce: A MISSING DAY IS NOT THE SAME
 * CLAIM IN EVERY SERIES, so the two series the chart can show are filled in
 * differently and neither is guessed at.
 *
 *  - Views are a per-day count. The query only returns days that had events, so
 *    a day with no row genuinely had no pageviews — it is filled with a real
 *    zero and plotted on the baseline.
 *  - Followers are a daily reading of a level. A day with no row means NO
 *    READING WAS TAKEN (a missed cron pass, a writer who signed up on Tuesday)
 *    — filling it with zero would tell a writer they lost every follower that
 *    day, and interpolating across it would invent a number. It stays null, the
 *    line breaks, and the caption says how many days weren't sampled.
 *
 * Pure module: rows in, rows out. No DOM, no I/O.
 */
import { dayDistance, isDay, shiftDay } from "~/lib/follower-snapshots";

/** A plottable day. `value: null` means "no reading", never zero. */
export type DailyPoint = { day: string; value: number | null };

/** Hard bound on the densified length — two years of days, comfortably past the
 * longest window any range asks for. A bound on a loop over date arithmetic is
 * cheap insurance against a bad window turning a render into a hang. */
export const MAX_SERIES_DAYS = 800;

/**
 * Expands sparse rows into one point per day across `[from, to]`.
 *
 * `missing` picks what an absent day means for this series — see the module
 * note. Rows outside the window are ignored, and a day appearing twice keeps
 * the last value rather than summing (the upstreams both group by day, so a
 * duplicate would be a bug worth not compounding).
 */
export function densifySeries(
  rows: Iterable<{ day: unknown; value: unknown }>,
  window: { from: string; to: string; missing: "zero" | "gap" },
): DailyPoint[] {
  const { from, to, missing } = window;
  if (!isDay(from) || !isDay(to) || from > to) return [];

  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (!isDay(row.day) || row.day < from || row.day > to) continue;
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
    byDay.set(row.day, row.value);
  }

  const span = Math.min(dayDistance(from, to) + 1, MAX_SERIES_DAYS);
  const out: DailyPoint[] = [];
  for (let i = 0; i < span; i++) {
    const day = shiftDay(from, i);
    const value = byDay.get(day);
    out.push({
      day,
      value: value ?? (missing === "zero" ? 0 : null),
    });
  }
  return out;
}

export type SeriesSummary = {
  /** Days that carry a real reading. */
  sampled: number;
  /** Days inside the series with no reading at all. */
  missingDays: number;
  total: number;
  /** Last reading minus first — the useful summary for a level series. */
  net: number;
  lowest: { day: string; value: number };
  highest: { day: string; value: number };
  firstDay: string;
  lastDay: string;
  /** Fewer than two readings: a number, not yet a trend. */
  insufficient: boolean;
};

/** The numbers the chart's caption, its screen-reader summary, and its
 * insufficient-history state all need. Null when nothing was sampled. */
export function seriesSummary(
  points: readonly DailyPoint[],
): SeriesSummary | null {
  const real = points.filter(
    (p): p is { day: string; value: number } => p.value !== null,
  );
  if (real.length === 0) return null;

  let lowest = real[0];
  let highest = real[0];
  let total = 0;
  for (const point of real) {
    if (point.value < lowest.value) lowest = point;
    if (point.value > highest.value) highest = point;
    total += point.value;
  }
  return {
    sampled: real.length,
    missingDays: points.length - real.length,
    total,
    net: real[real.length - 1].value - real[0].value,
    lowest,
    highest,
    firstDay: real[0].day,
    lastDay: real[real.length - 1].day,
    insufficient: real.length < 2,
  };
}

/** Above this many points the dots crowd the line and it reads cleaner without
 * them. */
export const MAX_DOTS = 31;
