/**
 * The plot itself — Recharts, loaded on demand.
 *
 * Default-exported and imported through `lazy()` so Recharts lands in its own
 * chunk instead of the shared bundle, and rendered inside `ClientOnly` so it
 * never runs during SSR. Same treatment the editor gets, for the same reason:
 * one heavy, purely visual dependency should cost only the surfaces that show it.
 *
 * VISUAL CONTRACT. The data line is this page's single vermillion moment;
 * everything else here is ink, ink-soft or hairline rule, all read from the
 * theme rather than written as hex. No elevation, no radius, no vertical
 * gridlines, no axis boxes — print doesn't draw a frame around a chart.
 *
 * TWO SERIES, NEVER TWO AXES. Views and followers are different units on
 * different scales; a twin-axis chart lets whoever picks the scales imply any
 * correlation they like. They are a toggle, one at a time, each with its own
 * honest axis:
 *
 *  - Views are a count, measured from zero, and get an area fill.
 *  - Followers are a level. Floored at zero, a writer going 1,200 → 1,240 draws
 *    a flat line, so the axis is fitted to the data — and precisely because the
 *    floor isn't zero, NOTHING IS FILLED. A shaded region above an arbitrary
 *    floor implies a magnitude the chart isn't showing.
 *
 * GAPS STAY GAPS. Unsampled days arrive as null and `connectNulls={false}`
 * leaves the line broken there. Interpolating would invent a reading; plotting
 * zero would claim a collapse. The caption says how many days went unsampled and
 * the data table lists only real samples.
 */
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";
import { type DailyPoint, MAX_DOTS } from "~/lib/chart-series";
import { formatDay, formatDayWithYear } from "./shared";

export type ChartSeriesKind = "views" | "followers";

/** Axis labels stay short so they can't collide on a phone; the tooltip and the
 * data table carry the exact numbers. */
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export default function ChartPlot({
  points,
  kind,
}: {
  points: DailyPoint[];
  kind: ChartSeriesKind;
}) {
  const zeroBaseline = kind === "views";
  const config = {
    value: {
      label: kind === "views" ? "Views" : "Followers",
      color: "var(--color-spot)",
    },
  } satisfies ChartConfig;

  const real = points.filter((point) => point.value !== null);

  // A fitted axis needs breathing room, or the line rides the frame. Padded by a
  // share of the band with a floor of one, so a two-follower swing still reads.
  let domain: [number | string, number | string] = [0, "auto"];
  if (!zeroBaseline && real.length > 0) {
    const values = real.map((point) => point.value as number);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const pad = Math.max(1, Math.round((high - low) * 0.2));
    domain = [Math.max(0, low - pad), high + pad];
  }

  return (
    <ChartConfigContainer config={config}>
      <AreaChart
        data={points}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        {/* Horizontal hairlines only. Vertical rules would box the plot in. */}
        <CartesianGrid
          stroke="var(--color-rule)"
          strokeDasharray="2 3"
          vertical={false}
        />
        <XAxis
          axisLine={{ stroke: "var(--color-rule)" }}
          dataKey="day"
          minTickGap={28}
          tickFormatter={formatDay}
          tickLine={false}
          tickMargin={8}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          domain={domain}
          tickFormatter={(value: number) => compact.format(value)}
          tickLine={false}
          tickMargin={6}
          width={44}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const day = payload?.[0]?.payload?.day;
                return typeof day === "string" ? formatDayWithYear(day) : "";
              }}
            />
          }
          cursor={{ stroke: "var(--color-ink)", strokeWidth: 1 }}
        />
        <Area
          activeDot={{ fill: "var(--color-value)", r: 3, strokeWidth: 0 }}
          connectNulls={false}
          dataKey="value"
          dot={
            real.length <= MAX_DOTS
              ? { fill: "var(--color-value)", r: 2, strokeWidth: 0 }
              : false
          }
          fill="var(--color-value)"
          fillOpacity={zeroBaseline ? 0.1 : 0}
          // Straight segments, not a spline: a curve through daily readings
          // draws values on days that were never sampled.
          type="linear"
          // Recharts' default `isAnimationActive="auto"` already stands down
          // under prefers-reduced-motion, so the draw-in needs no override.
          stroke="var(--color-value)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartConfigContainer>
  );
}

/** The documented shadcn requirement: a min height, or the responsive container
 * has nothing to resolve its height against and collapses. */
function ChartConfigContainer({
  config,
  children,
}: {
  config: ChartConfig;
  children: React.ComponentProps<typeof ChartContainer>["children"];
}) {
  return (
    <ChartContainer
      className="aspect-auto h-56 min-h-56 w-full sm:h-64 sm:min-h-64"
      config={config}
    >
      {children}
    </ChartContainer>
  );
}
