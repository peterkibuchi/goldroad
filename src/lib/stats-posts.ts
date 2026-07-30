/**
 * The per-post performance table's data: the loader's row shape, the join that
 * gives each row its numbers, and the sort.
 *
 * Two rules run through all of it.
 *
 * ABSENT IS NOT ZERO. A post with no matching pageview path, or no announcement
 * on Bluesky, has no number — not a zero. Reader counts are cookieless and
 * genuinely miss people, older posts predate the counting entirely, and an
 * unannounced post has no thread for anyone to have liked. Rendering `0` in any
 * of those cells would state something false, so those cells carry null and the
 * table draws a dash.
 *
 * A TABLE NEVER HIDES ROWS IT LACKS NUMBERS FOR. The dashboard's own join drops
 * unmatched rows because a strip of view counts is a strip of view counts. Here
 * the table is the writer's whole archive; dropping rows would misreport how
 * much they have written.
 */
import type { EngagementPost } from "~/lib/stats-sections";

/** Row as the loader serializes it — deliberately small. The document bodies
 * are dropped before the payload leaves the server: two hundred full posts
 * would be megabytes of JSON in the HTML for numbers nobody reads. */
export type StatsPostRow = {
  rkey: string;
  title: string;
  publishedAt: string | null;
  /** The published date, already formatted on the server so the same string
   * renders on both sides of hydration. */
  date: string | null;
  /** Approximate minutes, or null when the document's text lives elsewhere. */
  readingMinutes: number | null;
  /** Rich-content-union documents (written in another app) can't be edited
   * here; the table marks them the way the posts list does. */
  editable: boolean;
  /** The announcement on Bluesky, from the record's own write-back. */
  announced: { did: string; postRkey: string; uri: string } | null;
};

/** Average characters per word in English prose, including the space. */
const CHARS_PER_WORD = 5.6;

/** Reading speed for non-fiction prose. */
const WORDS_PER_MINUTE = 220;

/**
 * Reading minutes from a body LENGTH rather than a word count.
 *
 * Deliberately one division instead of a scan. This runs once per post over a
 * page of up to two hundred posts inside a request with a ten-millisecond CPU
 * budget, and a regex sweep over a megabyte of third-party prose is exactly the
 * shape of scan that has bitten this request path before. The estimate is
 * within a rounding minute of a word count on real prose, which is all a
 * "7 min" label ever claims.
 */
export function approximateReadingMinutes(
  text: string | undefined,
): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  return Math.max(
    1,
    Math.round(text.length / CHARS_PER_WORD / WORDS_PER_MINUTE),
  );
}

export type PostMetrics = StatsPostRow & {
  views: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  /** The announcement isn't on Bluesky anymore. */
  gone: boolean;
};

/**
 * Joins reader counts (by path) and Bluesky counts (by record key) onto the
 * writer's rows. The path is built the same way the reading surface builds a
 * post's URL, so the two can't drift.
 */
export function joinMetricsToRows(input: {
  rows: readonly StatsPostRow[];
  paths: ReadonlyArray<{ path: string; views: number }> | null;
  engagement: readonly EngagementPost[] | null;
  ident: string;
}): PostMetrics[] {
  const { rows, paths, engagement, ident } = input;
  const viewsByPath = new Map((paths ?? []).map((p) => [p.path, p.views]));
  const byRkey = new Map((engagement ?? []).map((p) => [p.rkey, p]));

  return rows.map((row) => {
    const counts = byRkey.get(row.rkey);
    const views =
      paths === null ? null : viewsByPath.get(pathFor(ident, row.rkey));
    return {
      ...row,
      views: views ?? null,
      likes: counts?.likes ?? null,
      reposts: counts?.reposts ?? null,
      replies: counts?.replies ?? null,
      gone: counts?.gone === true,
    };
  });
}

/** The public URL path of one of this writer's posts. */
export function pathFor(ident: string, rkey: string): string {
  return `/@${ident}/${rkey}`;
}

export const SORT_KEYS = [
  "date",
  "title",
  "views",
  "likes",
  "reposts",
  "replies",
  "read",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export const DEFAULT_SORT: SortKey = "date";
export const DEFAULT_DIRECTION: SortDirection = "desc";

export function parseSortKey(value: unknown): SortKey {
  return typeof value === "string" &&
    (SORT_KEYS as readonly string[]).includes(value)
    ? (value as SortKey)
    : DEFAULT_SORT;
}

export function parseSortDirection(value: unknown): SortDirection {
  return value === "asc" ? "asc" : DEFAULT_DIRECTION;
}

/** The sortable value of one cell: a number, a string, or null for "we have no
 * number", which is a third thing and sorts as one. */
function sortValue(row: PostMetrics, key: SortKey): number | string | null {
  switch (key) {
    case "title":
      return row.title.toLocaleLowerCase();
    case "date":
      return row.publishedAt === null
        ? null
        : Date.parse(row.publishedAt) || null;
    case "views":
      return row.views;
    case "likes":
      return row.likes;
    case "reposts":
      return row.reposts;
    case "replies":
      return row.replies;
    case "read":
      return row.readingMinutes;
  }
}

/**
 * Sorts a copy of the rows.
 *
 * UNKNOWNS ALWAYS SORT LAST, in both directions. "We have no number" is not
 * "zero", so it must not win an ascending sort — a writer sorting by views
 * ascending is asking which post did worst, and the answer is not "the twelve
 * posts published before we started counting".
 */
export function sortPostMetrics(
  rows: readonly PostMetrics[],
  key: SortKey,
  direction: SortDirection,
): PostMetrics[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null || right === null) {
      if (left === right) return a.rkey < b.rkey ? -1 : 1;
      return left === null ? 1 : -1;
    }
    if (typeof left === "string" || typeof right === "string") {
      const compared = String(left).localeCompare(String(right));
      return compared === 0 ? (a.rkey < b.rkey ? -1 : 1) : compared * sign;
    }
    // Record key breaks ties so a re-sort is stable rather than hash-ordered.
    return left === right ? (a.rkey < b.rkey ? -1 : 1) : (left - right) * sign;
  });
}
