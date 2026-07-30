/**
 * The four numbers a writer opened this page for.
 *
 * Chosen so that AT LEAST TWO OF THEM WORK ON DAY ONE with no history at all:
 * the Bluesky conversation needs no cold start (the network already holds the
 * counts) and a view lands as soon as one reader does.
 *
 * Treatment: cells in a ruled grid, radius 0, no elevation. The numbers are
 * Franklin at display weight in tabular numerals — that already gives them the
 * most visual mass on the page, so colour would be redundant emphasis competing
 * with the chart. Deltas are INK, never green and never red: this page has one
 * accent and it is spent on the chart, and a dip in readership is a normal week
 * in a writer's life, not an alarm. We do not paint a writer's Tuesday red.
 */
import type { StatsRange } from "~/lib/stats";
import type { StatsEnvelope } from "~/lib/stats-sections";
import { formatCount, LINK_CLASS, RANGE_PHRASE, SkeletonBar } from "./shared";

const UNAVAILABLE =
  "This number couldn't be loaded right now. Refresh to try again.";
const NOT_CONFIGURED = "Reader counts aren't switched on for this site.";

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-paper px-4 py-4 sm:px-5 sm:py-5">
      <h3 className="font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]">
        {label}
      </h3>
      {children}
    </div>
  );
}

/** The number itself. Display weight, tabular so a changing range doesn't make
 * the digits dance. */
function Value({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 font-black font-display text-3xl text-ink tabular-nums tracking-tight">
      {children}
    </p>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 font-display text-ink-soft text-xs leading-relaxed">
      {children}
    </p>
  );
}

/** Value and sub-line as skeletons at final geometry; the label is real text
 * from the first paint, so the page's shape never jumps. */
function CardSkeleton() {
  return (
    <>
      <SkeletonBar className="mt-3 h-6 w-24" />
      <SkeletonBar className="mt-2.5 h-3 w-40" />
    </>
  );
}

/** No number, and absence is the truth — a dash, plus the sentence that says
 * why. Never a bare zero. */
function Absent({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Value>—</Value>
      <Sub>{children}</Sub>
    </>
  );
}

/**
 * The previous-period comparison, only when it is honest.
 *
 * The server resolves comparability (there has to be a previous window we could
 * actually have collected, and it has to be above zero — a percentage change
 * from nothing is undefined, and an infinity in a stat card is a bug wearing a
 * party hat). This function only renders what it's told is comparable.
 */
function ViewsDelta({
  total,
  previousTotal,
  range,
}: {
  total: number;
  previousTotal: number;
  range: StatsRange;
}) {
  const phrase = RANGE_PHRASE[range];
  if (total === previousTotal) return <>Level with the previous {phrase}</>;
  const pct = Math.round(
    (Math.abs(total - previousTotal) / previousTotal) * 100,
  );
  const rising = total > previousTotal;
  return (
    <>
      <span aria-hidden="true">{rising ? "↑" : "↓"}</span>
      <span className="sr-only">{rising ? "up" : "down"}</span> {pct}% vs
      previous {phrase}
    </>
  );
}

export type TopPost = { rkey: string; title: string; views: number };

export function StatCards({
  metrics,
  range,
  topPost,
  postHref,
}: {
  /** null while the numbers are still in flight. */
  metrics: StatsEnvelope | null;
  range: StatsRange;
  topPost: TopPost | null;
  postHref: (rkey: string) => string;
}) {
  const loading = metrics === null;
  const views = metrics?.views;
  const followers = metrics?.followers;
  const engagement = metrics?.engagement;
  const phrase = RANGE_PHRASE[range];

  return (
    // gap-px over a rule-coloured background draws the hairline grid without a
    // border on every cell — print rules, not widget frames.
    <div className="mt-8 grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Views">
        {loading ? (
          <CardSkeleton />
        ) : views?.status === "not_configured" ? (
          <Absent>{NOT_CONFIGURED}</Absent>
        ) : views?.status === "unavailable" ? (
          <Absent>{UNAVAILABLE}</Absent>
        ) : (views?.total ?? 0) === 0 ? (
          <Absent>No views in this range yet.</Absent>
        ) : (
          <>
            <Value>{formatCount(views?.total ?? 0)}</Value>
            <Sub>
              {views?.comparable && views.previousTotal !== undefined ? (
                <ViewsDelta
                  previousTotal={views.previousTotal}
                  range={range}
                  total={views.total ?? 0}
                />
              ) : range === "all" ? (
                <>Everything we've counted so far.</>
              ) : (
                <>Your first {phrase} — a comparison appears next period.</>
              )}
            </Sub>
          </>
        )}
      </Card>

      <Card label="Followers on Bluesky">
        {loading ? (
          <CardSkeleton />
        ) : followers?.status === "unavailable" ? (
          <Absent>{UNAVAILABLE}</Absent>
        ) : followers?.current === undefined ? (
          <Absent>
            Your follower count is read once a day — the first reading lands
            within the day.
          </Absent>
        ) : (
          <>
            <Value>{formatCount(followers.current)}</Value>
            <Sub>
              {followers.status === "insufficient_history" ||
              followers.net === undefined ? (
                <>First reading today — your trend starts tomorrow.</>
              ) : followers.net === 0 ? (
                <>Level over {phrase}</>
              ) : followers.net > 0 ? (
                <>
                  +{formatCount(followers.net)} in {phrase}
                </>
              ) : (
                <>
                  {formatCount(Math.abs(followers.net))} fewer in {phrase}
                </>
              )}
            </Sub>
          </>
        )}
      </Card>

      <Card label="Likes, reposts, replies">
        {loading ? (
          <CardSkeleton />
        ) : engagement?.status === "unavailable" ? (
          <Absent>{UNAVAILABLE}</Absent>
        ) : engagement?.totals === undefined ? (
          <Absent>
            Share a post to Bluesky and what it earns shows up here.
          </Absent>
        ) : (
          <>
            <Value>
              {formatCount(
                engagement.totals.likes +
                  engagement.totals.reposts +
                  engagement.totals.replies,
              )}
            </Value>
            {/* The denominator, always: a count with no "out of how many posts"
                is a number a writer can't act on. */}
            <Sub>
              across {formatCount(engagement.countedPosts ?? 0)}{" "}
              {engagement.countedPosts === 1 ? "post" : "posts"} you shared to
              Bluesky
            </Sub>
          </>
        )}
      </Card>

      <Card label="Most read">
        {loading ? (
          <CardSkeleton />
        ) : views?.status === "not_configured" ? (
          <Absent>{NOT_CONFIGURED}</Absent>
        ) : views?.status === "unavailable" ? (
          <Absent>{UNAVAILABLE}</Absent>
        ) : topPost === null ? (
          <Absent>No post has been read in this range yet.</Absent>
        ) : (
          <>
            {/* A title, not a number — so this card's value is a link, clamped
                so a long headline can't make the cell taller than its siblings. */}
            <p className="mt-2 font-bold font-display text-base text-ink leading-snug">
              <a className={LINK_CLASS} href={postHref(topPost.rkey)}>
                <span className="line-clamp-2">{topPost.title}</span>
              </a>
            </p>
            <Sub>
              {formatCount(topPost.views)}{" "}
              {topPost.views === 1 ? "view" : "views"} in {phrase}
            </Sub>
          </>
        )}
      </Card>
    </div>
  );
}
