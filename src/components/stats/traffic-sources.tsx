/**
 * "Where readers came from" — the section that answers the question this whole
 * product exists to answer: is publishing where my readers already are actually
 * working? A writer who can see "61% Bluesky" has a reason to keep sharing; a
 * writer who can't is guessing.
 *
 * A ruled list, not a pie chart. Every row is fully readable as label + number
 * without its bar, so the bars are decoration and carry `aria-hidden`.
 *
 * The limitation line under the bars is REQUIRED, not optional. Two things are
 * true and both change how the numbers should be read, so both get said out
 * loud rather than buried in a policy page.
 */
import { BUCKET_ORDER, type SourceBucket } from "~/lib/referrers";
import type { SourcesSection } from "~/lib/stats-sections";
import {
  formatCount,
  LoadingRegion,
  QuietLine,
  SectionHeading,
  SkeletonBar,
} from "./shared";

const BUCKET_LABELS: Readonly<Record<SourceBucket, string>> = {
  bluesky: "Bluesky",
  // Deliberately not "Direct" alone: some of this bucket is Bluesky whose app
  // didn't pass on where the reader came from, and the label shouldn't imply a
  // certainty we don't have.
  direct: "Direct or unknown",
  search: "Search",
  internal: "Within your site",
  other: "Other sites",
};

const LIMITATION =
  "What this can't tell you: many Bluesky apps open links without passing on where the reader came from, so your Bluesky share is a floor, not a total — some of “Direct or unknown” is Bluesky too. And because we don't follow readers around, these are arrivals in total, never one reader's path.";

function Row({
  label,
  views,
  total,
  children,
}: {
  label: string;
  views: number;
  total: number;
  children?: React.ReactNode;
}) {
  const percent = total > 0 ? Math.round((views / total) * 100) : 0;
  return (
    <div className="border-rule border-b py-2.5">
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="w-32 shrink-0 font-display text-ink text-sm sm:w-44">
          {label}
        </span>
        {/* Ink at 82%: present enough to compare lengths, quiet enough not to
            compete with the chart's line. Radius 0. */}
        <span aria-hidden="true" className="hidden min-w-0 flex-1 sm:block">
          <span
            className="block h-2.5 bg-ink/80"
            style={{ width: `${Math.max(percent, 1)}%` }}
          />
        </span>
        <span className="ml-auto shrink-0 font-display text-ink text-sm tabular-nums sm:ml-0">
          {percent}%
          <span className="ml-2 text-ink-soft">{formatCount(views)}</span>
        </span>
      </div>
      {children}
    </div>
  );
}

function SourcesSkeleton() {
  return (
    <LoadingRegion label="Loading traffic sources…">
      <div className="mt-2">
        {[0, 1, 2, 3].map((index) => (
          <div className="border-rule border-b py-2.5" key={index}>
            <SkeletonBar className="h-4 w-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function TrafficSources({
  sources,
}: {
  sources: SourcesSection | null;
}) {
  return (
    <section aria-labelledby="sources-heading" className="mt-10">
      <SectionHeading id="sources-heading">
        Where readers came from
      </SectionHeading>
      {sources === null ? (
        <SourcesSkeleton />
      ) : sources.status === "not_configured" ? (
        <QuietLine className="mt-3">
          Reader counts aren't switched on for this site.
        </QuietLine>
      ) : sources.status === "unavailable" ? (
        <QuietLine className="mt-3">
          Traffic sources couldn't be loaded right now. Refresh to try again.
        </QuietLine>
      ) : sources.status === "empty" ? (
        <QuietLine className="mt-3">No views in this range yet.</QuietLine>
      ) : sources.status === "insufficient_history" ? (
        // A three-view sample rendered as percentages is noise dressed as
        // insight, so we say what's true instead of drawing it.
        <QuietLine className="mt-3">
          Too few views to break down yet — this fills in around ten views.
        </QuietLine>
      ) : (
        <>
          <div className="mt-2">
            {(sources.buckets ?? [])
              .slice()
              .sort(
                (a, b) =>
                  b.views - a.views ||
                  BUCKET_ORDER.indexOf(a.bucket) -
                    BUCKET_ORDER.indexOf(b.bucket),
              )
              .map((row) => (
                <Row
                  key={row.bucket}
                  label={BUCKET_LABELS[row.bucket]}
                  total={sources.total ?? 0}
                  views={row.views}
                >
                  {row.bucket === "other" &&
                    (sources.topOtherDomains ?? []).length > 0 && (
                      <details className="mt-1.5">
                        <summary className="inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-xs underline underline-offset-2 transition-colors hover:text-ink">
                          Which sites
                        </summary>
                        <ul className="mt-1 space-y-1">
                          {(sources.topOtherDomains ?? []).map((domain) => (
                            <li
                              className="flex items-baseline justify-between gap-4 font-display text-ink-soft text-xs"
                              key={domain.domain}
                            >
                              <span className="min-w-0 truncate">
                                {domain.domain}
                              </span>
                              <span className="shrink-0 tabular-nums">
                                {formatCount(domain.views)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                </Row>
              ))}
          </div>
          <QuietLine className="mt-3 max-w-[68ch]">{LIMITATION}</QuietLine>
        </>
      )}
    </section>
  );
}
