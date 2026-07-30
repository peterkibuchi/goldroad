/**
 * The window everything below it is measured over.
 *
 * A real group of buttons with `aria-pressed`, not a custom widget: keyboard and
 * screen-reader users get an ordinary labelled control, and the selection lives
 * in the URL so a view survives a refresh and the back button.
 *
 * The active segment is an ink fill, never vermillion. Selection is structure,
 * not emphasis — and the page's one accent moment belongs to the chart.
 */
import type { StatsRange } from "~/lib/stats";
import { cn } from "~/lib/utils";

const RANGES: ReadonlyArray<{
  value: StatsRange;
  /** Full label — what assistive tech reads, and what shows when there's room. */
  long: string;
  /** What survives on a narrow screen. */
  short: string;
}> = [
  { value: "7d", long: "7 days", short: "7d" },
  { value: "30d", long: "30 days", short: "30d" },
  { value: "90d", long: "90 days", short: "90d" },
  { value: "all", long: "All time", short: "All" },
];

export function RangePicker({
  range,
  onChange,
}: {
  range: StatsRange;
  onChange: (range: StatsRange) => void;
}) {
  return (
    // A real fieldset rather than a div with role="group": the legend gives the
    // group its accessible name without a second ARIA attribute to keep in sync.
    <fieldset className="flex divide-x divide-ink border border-ink">
      <legend className="sr-only">Time range</legend>
      {RANGES.map((option) => {
        const isActive = option.value === range;
        return (
          <button
            aria-label={option.long}
            aria-pressed={isActive}
            className={cn(
              "inline-flex min-h-11 cursor-pointer items-center px-3 font-display text-sm transition-colors focus-visible:-outline-offset-2 sm:px-4",
              isActive
                ? "bg-ink font-bold text-paper"
                : "text-ink-soft hover:bg-ink/5 hover:text-ink",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span aria-hidden="true" className="sm:hidden">
              {option.short}
            </span>
            <span aria-hidden="true" className="hidden sm:inline">
              {option.long}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}
