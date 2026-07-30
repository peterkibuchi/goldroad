/**
 * "Every post" — the dig-in surface. Everything we know about every post in one
 * sortable grid: the thing a writer opens when they want to find the pattern
 * themselves rather than be told one.
 *
 * Three rules it exists to keep.
 *
 * ROWS RENDER BEFORE NUMBERS DO. Titles, dates and reading time come from the
 * page's own loader, so the table is on screen with real content while the
 * metrics are still in flight — only the metric cells are skeletons. It is the
 * best loading state on the page and it costs nothing.
 *
 * A DASH IS NOT A ZERO, and unknowns sort LAST in both directions. Sorting by
 * views ascending asks which post did worst; the answer is not "the twelve posts
 * published before we started counting".
 *
 * THE TABLE BECOMES CARDS ON A PHONE. A horizontally scrolling six-column table
 * on a 390px screen is a table nobody reads, so below 640px each post is a
 * stacked block and the sort moves into a labelled select.
 */
import { ExternalLink } from "~/components/external-link";
import { bskyPostUrl } from "~/lib/engagement";
import type { PostMetrics, SortDirection, SortKey } from "~/lib/stats-posts";
import { cn } from "~/lib/utils";
import {
  formatCount,
  LINK_CLASS,
  Metric,
  QuietLine,
  SectionHeading,
  SkeletonBar,
} from "./shared";

/** Numeric columns are right-aligned so digits line up down the column, and the
 * narrow cell class is shared by header and body so they can never disagree
 * about which columns survive a narrower window. */
const NUMERIC_CELL = "py-3 pl-3 text-right text-ink text-sm tabular-nums";

/** Reposts is the first column to go when space runs short — it is the
 * least-asked-for number on the page, and it stays in the mobile list. */
const WIDE_ONLY = "hidden lg:table-cell";

const SORT_OPTIONS: ReadonlyArray<{
  value: `${SortKey}:${SortDirection}`;
  label: string;
}> = [
  { value: "date:desc", label: "Newest first" },
  { value: "date:asc", label: "Oldest first" },
  { value: "views:desc", label: "Most views" },
  { value: "views:asc", label: "Fewest views" },
  { value: "likes:desc", label: "Most likes" },
  { value: "replies:desc", label: "Most replies" },
  { value: "read:desc", label: "Longest read" },
  { value: "title:asc", label: "Title A–Z" },
];

const LEGEND =
  "A dash means we have no number, not zero — reader counts miss some readers, and a post you haven't shared to Bluesky has no likes or replies to show.";

function MetricCell({
  value,
  loading,
  suffix,
}: {
  value: number | null;
  loading: boolean;
  suffix?: string;
}) {
  if (loading) return <SkeletonBar className="ml-auto h-3 w-10" />;
  if (value === null) return <Metric value={null} />;
  return (
    <>
      {formatCount(value)}
      {suffix ? <span className="text-ink-soft"> {suffix}</span> : null}
    </>
  );
}

/** Column header: a real button inside the `<th>`, with `aria-sort` on the cell
 * so assistive tech reads the state rather than inferring it from a glyph. */
function SortHeader({
  columnKey,
  label,
  numeric = true,
  className,
  sort,
  direction,
  onSort,
}: {
  columnKey: SortKey;
  label: string;
  numeric?: boolean;
  className?: string;
  sort: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const isActive = sort === columnKey;
  return (
    <th
      aria-sort={
        isActive ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={cn(
        "py-2 font-normal",
        numeric ? "text-right" : "text-left",
        className,
      )}
      scope="col"
    >
      <button
        aria-label={`Sort by ${label}`}
        className={cn(
          "inline-flex min-h-9 cursor-pointer items-center gap-1 font-display font-semibold text-xs uppercase tracking-[0.06em] transition-colors focus-visible:-outline-offset-2",
          isActive ? "text-ink" : "text-ink-soft hover:text-ink",
        )}
        onClick={() => onSort(columnKey)}
        type="button"
      >
        {label}
        <span aria-hidden="true" className={isActive ? "" : "opacity-0"}>
          {direction === "asc" ? "↑" : "↓"}
        </span>
      </button>
    </th>
  );
}

export function PostTable({
  rows,
  ident,
  sort,
  direction,
  onSortChange,
  /** Metrics are still in flight — titles and dates are real, numbers aren't. */
  loading,
  /** The loader hit its page ceiling: this is a page, not the archive. */
  truncated,
  /** Both metric upstreams failed; the rows are still the writer's own posts. */
  metricsUnavailable,
}: {
  rows: PostMetrics[];
  ident: string;
  sort: SortKey;
  direction: SortDirection;
  onSortChange: (sort: SortKey, direction: SortDirection) => void;
  loading: boolean;
  truncated: boolean;
  metricsUnavailable: boolean;
}) {
  const postHref = (rkey: string) =>
    `/@${encodeURIComponent(ident)}/${encodeURIComponent(rkey)}`;

  /** Clicking the active column flips it; a new column starts descending —
   * "most" is what a writer means by sorting a metric. */
  const toggle = (key: SortKey) =>
    onSortChange(
      key,
      sort === key ? (direction === "asc" ? "desc" : "asc") : "desc",
    );

  return (
    <section aria-labelledby="table-heading" className="mt-10">
      <SectionHeading
        action={
          <label className="flex items-center gap-2 font-display text-ink-soft text-xs sm:hidden">
            Sort by
            <select
              className="min-h-9 border border-ink bg-paper px-2 font-display text-ink text-xs"
              onChange={(event) => {
                const [key, dir] = event.target.value.split(":");
                onSortChange(key as SortKey, dir as SortDirection);
              }}
              value={`${sort}:${direction}`}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        }
        id="table-heading"
      >
        Every post
      </SectionHeading>

      {truncated && (
        <QuietLine className="mt-3">
          Showing your 200 most recent posts.{" "}
          <a className={LINK_CLASS} href="/dashboard">
            See the full archive in Posts.
          </a>
        </QuietLine>
      )}
      {metricsUnavailable && (
        <QuietLine className="mt-3">
          Your posts are here; the numbers couldn't be loaded right now. Refresh
          to try again.
        </QuietLine>
      )}

      {/* Desktop: a real table, so a screen reader gets row/column semantics. */}
      <table className="mt-2 hidden w-full font-display sm:table">
        <thead>
          <tr className="border-ink border-b">
            <SortHeader
              columnKey="title"
              direction={direction}
              label="Post"
              numeric={false}
              onSort={toggle}
              sort={sort}
            />
            <SortHeader
              columnKey="views"
              direction={direction}
              label="Views"
              onSort={toggle}
              sort={sort}
            />
            <SortHeader
              columnKey="likes"
              direction={direction}
              label="Likes"
              onSort={toggle}
              sort={sort}
            />
            <SortHeader
              className={WIDE_ONLY}
              columnKey="reposts"
              direction={direction}
              label="Reposts"
              onSort={toggle}
              sort={sort}
            />
            <SortHeader
              columnKey="replies"
              direction={direction}
              label="Replies"
              onSort={toggle}
              sort={sort}
            />
            <SortHeader
              columnKey="read"
              direction={direction}
              label="Read"
              onSort={toggle}
              sort={sort}
            />
            <th className="w-px py-2" scope="col">
              <span className="sr-only">Thread</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-rule border-b align-top" key={row.rkey}>
              <th
                className="max-w-0 py-3 pr-4 text-left font-normal"
                scope="row"
              >
                <a className={LINK_CLASS} href={postHref(row.rkey)}>
                  <span className="font-semibold text-ink text-sm">
                    {row.title}
                  </span>
                </a>
                <span className="mt-0.5 block text-ink-soft text-xs">
                  {row.date}
                  {!row.editable && (
                    <span>{row.date ? " · " : ""}Written in another app</span>
                  )}
                </span>
              </th>
              <td className={NUMERIC_CELL}>
                <MetricCell loading={loading} value={row.views} />
              </td>
              <td className={NUMERIC_CELL}>
                <MetricCell loading={loading} value={row.likes} />
              </td>
              <td className={cn(NUMERIC_CELL, WIDE_ONLY)}>
                <MetricCell loading={loading} value={row.reposts} />
              </td>
              <td className={NUMERIC_CELL}>
                {loading ? (
                  <SkeletonBar className="ml-auto h-3 w-10" />
                ) : row.replies !== null && row.announced ? (
                  <ExternalLink
                    className={`tabular-nums ${LINK_CLASS}`}
                    href={bskyPostUrl(
                      row.announced.did,
                      row.announced.postRkey,
                    )}
                  >
                    {formatCount(row.replies)}
                  </ExternalLink>
                ) : (
                  <Metric value={row.replies} />
                )}
              </td>
              <td className={NUMERIC_CELL}>
                <MetricCell
                  loading={loading}
                  suffix="min"
                  value={row.readingMinutes}
                />
              </td>
              <td className="py-3 pl-3 text-right">
                {row.announced && (
                  <ExternalLink
                    className={`whitespace-nowrap text-xs ${LINK_CLASS}`}
                    href={bskyPostUrl(
                      row.announced.did,
                      row.announced.postRkey,
                    )}
                  >
                    Thread ↗
                  </ExternalLink>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Below 640px: stacked blocks, metrics as a wrapping label/value list. */}
      <ul className="mt-2 border-ink border-t sm:hidden">
        {rows.map((row) => (
          <li className="border-rule border-b py-3" key={row.rkey}>
            <a className={LINK_CLASS} href={postHref(row.rkey)}>
              <span className="font-semibold text-ink text-sm">
                {row.title}
              </span>
            </a>
            <p className="mt-0.5 font-display text-ink-soft text-xs">
              {row.date}
              {!row.editable && (
                <span>{row.date ? " · " : ""}Written in another app</span>
              )}
            </p>
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-display text-sm">
              {(
                [
                  ["Views", row.views, undefined],
                  ["Likes", row.likes, undefined],
                  ["Reposts", row.reposts, undefined],
                  ["Replies", row.replies, undefined],
                  ["Read", row.readingMinutes, "min"],
                ] as const
              ).map(([label, value, suffix]) => (
                <span
                  className="whitespace-nowrap text-ink tabular-nums"
                  key={label}
                >
                  <span className="text-ink-soft text-xs">{label} </span>
                  {loading ? (
                    <SkeletonBar className="inline-block h-3 w-8 align-middle" />
                  ) : (
                    <MetricCell loading={false} suffix={suffix} value={value} />
                  )}
                </span>
              ))}
            </p>
            {row.announced && (
              <p className="mt-1.5">
                <ExternalLink
                  className={`font-display text-xs ${LINK_CLASS}`}
                  href={bskyPostUrl(row.announced.did, row.announced.postRkey)}
                >
                  Open thread ↗
                </ExternalLink>
              </p>
            )}
          </li>
        ))}
      </ul>

      <QuietLine className="mt-3 max-w-[68ch]">{LEGEND}</QuietLine>
    </section>
  );
}
