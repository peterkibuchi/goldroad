/**
 * Pure display helpers for the publication archive/masthead page
 * (`~/routes/@{$handle}.index`): month/year grouping, the quiet client-side
 * search affordance, and the no-cover thumbnail monogram. No network/atproto
 * imports — these run over data the route already fetched.
 */

/** "January 2026" for a group header. Records with no publishedAt (drafts
 * imported without a date, or a legacy record predating the field) fall into
 * a shared "Undated" bucket at the end rather than being silently dropped —
 * they're still real posts in the writer's archive. */
export function monthYearLabel(iso: string | null): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "Undated";
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type ArchiveGroup<T> = { label: string; posts: T[] };

/**
 * Groups an ALREADY-SORTED (newest first) post list into consecutive
 * month/year buckets — a pure client-side skim rhythm, no new data and no
 * re-sort (a label appearing twice non-consecutively would be a caller sort
 * bug, not something this function should paper over).
 */
export function groupPostsByMonth<T extends { publishedAt: string | null }>(
  posts: T[],
): ArchiveGroup<T>[] {
  const groups: ArchiveGroup<T>[] = [];
  for (const post of posts) {
    const label = monthYearLabel(post.publishedAt);
    const current = groups.at(-1);
    if (current && current.label === label) {
      current.posts.push(post);
    } else {
      groups.push({ label, posts: [post] });
    }
  }
  return groups;
}

/**
 * Does one post match a search query? Case-insensitive substring over its
 * title or dek. An empty (or whitespace-only) query matches everything —
 * "no filter", not "match nothing".
 *
 * Split out from filterPostsByQuery below so the row-at-a-time callers (the
 * writer's posts manager hands this to a table's global-filter hook) and the
 * whole-list caller (the public archive) can never drift into two different
 * definitions of "matches".
 */
export function matchesPostQuery(
  post: { title: string; description: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    post.title.toLowerCase().includes(q) ||
    (post.description?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Quiet client-side search over ALREADY-LOADED posts — no new backend, no new
 * fetch.
 */
export function filterPostsByQuery<
  T extends { title: string; description: string | null },
>(posts: T[], query: string): T[] {
  if (query.trim() === "") return posts;
  return posts.filter((post) => matchesPostQuery(post, query));
}

/** First grapheme, uppercased — the monogram for a cover-less thumbnail
 * placeholder (never splits an emoji/combining sequence, same primitive
 * ~/lib/announce uses for grapheme-safe truncation). Never empty: a blank
 * or whitespace-only name falls back to "?". */
export function monogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = [...new Intl.Segmenter().segment(trimmed)][0]?.segment ?? "?";
  return first.toUpperCase();
}
