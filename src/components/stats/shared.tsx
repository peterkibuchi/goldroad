/**
 * The pieces every section of the analytics surface shares: a section heading,
 * the one-line "we can't show this right now" voice, the skeleton bars that
 * stand in for numbers while they load, and the formatters.
 *
 * Register: Pressroom throughout. Hairline rules and type hierarchy do the
 * organising — no rounded corners, no elevation, no coloured status chips, and
 * no icon standing in for a label. A stat "card" here is a cell in a ruled
 * grid, not a floating panel.
 *
 * The page spends its single accent moment on the chart's data line. Nothing in
 * this file is allowed to reach for it.
 */
import type { StatsRange } from "~/lib/stats";
import { cn } from "~/lib/utils";

/** Grouping numerals so a five-figure view count is readable at a glance. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** A short day label for axes and captions. Fixed locale + UTC so the same
 * string renders on the server and the client — days are UTC everywhere on this
 * surface, and shifting one series and not the other would be worse than a
 * writer in Nairobi reading UTC days. */
export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** The same day with its year — for the left edge of a long range, where
 * "3 Jan" alone is ambiguous. */
export function formatDayWithYear(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** How a range reads inside a sentence ("+38 in 30 days"). */
export const RANGE_PHRASE: Readonly<Record<StatsRange, string>> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "all time",
};

/** Where we have no number, we say so. A dash, never a zero: absence and zero
 * are different claims, and the legend under every table says which is which. */
function Dash() {
  return (
    <>
      <span aria-hidden="true" className="text-ink-soft">
        —
      </span>
      {/* The glyph alone is silence to a screen reader, which would sound like
          a missing cell rather than a stated absence. */}
      <span className="sr-only">no number</span>
    </>
  );
}

/** A number, or a dash when we have none. */
export function Metric({ value }: { value: number | null }) {
  return value === null ? <Dash /> : formatCount(value);
}

/** Section heading: the surface is organised by type and hairlines, so headings
 * carry a rule rather than sitting inside a box. */
export function SectionHeading({
  id,
  children,
  action,
}: {
  id: string;
  children: React.ReactNode;
  /** Optional control on the heading's own baseline (a series toggle). */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-rule border-b pb-2">
      <h2
        className="font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id={id}
      >
        {children}
      </h2>
      {action}
    </div>
  );
}

/** The surface's quiet voice: an explanation, a limitation, or a "can't reach
 * this right now". Never an alarm — a section we can't fill is a fact about our
 * plumbing, not about the writer's work. */
export function QuietLine({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "font-display text-ink-soft text-xs leading-relaxed",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Pulse bar standing in for a number that hasn't arrived. Skeletons, never
 * spinners: the page's shape is known before its numbers are, so it should never
 * jump. `motion-reduce` stops the pulse without hiding the placeholder.
 */
export function SkeletonBar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block animate-pulse bg-rule/60 motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/** A whole section replaced by a skeleton, announced politely to screen
 * readers so the wait is audible as a wait. */
export function LoadingRegion({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite" role="status">
      {children}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Inline text link — the shipped secondary-action vocabulary. Ink-soft and
 * underlined, hovering to ink: a page of vermillion links would drown the one
 * accent that matters. */
export const LINK_CLASS =
  "text-ink-soft underline underline-offset-2 transition-colors hover:text-ink";
