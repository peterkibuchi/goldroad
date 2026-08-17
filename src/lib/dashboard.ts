/**
 * Posts-manager view models — pure record → row transforms over the writer's
 * own site.standard.document listRecords page (untrusted shapes), plus the
 * client-side ordering the manager's sort control applies.
 */
import {
  type ListedRecord,
  parseAtUri,
  rkeyFromUri,
  type StandardDocument,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import {
  documentBodyMarkdown,
  hasForeignContent,
} from "~/lib/document-content";
import { listItemReadingMinutes } from "~/lib/reading-time";

export type DashboardRow = {
  rkey: string;
  title: string;
  /** Excerpt shown under the title — scanability on long lists. */
  description: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  /**
   * The post's cover image, served through the /img proxy — null when the
   * record has no valid cover blob. The row's thumbnail slot falls back to a
   * monogram so a cover-less post never leaves a hole in the list rhythm.
   */
  coverPath: string | null;
  /** Reading-time estimate over the record's own body; 0 when there is no
   * body to estimate from (an empty post, or one whose text lives entirely in
   * a foreign content union we don't read). */
  readingMinutes: number;
  /**
   * Documents carrying a FOREIGN content union (e.g. Leaflet's
   * pub.leaflet.content) are not editable here (editing only textContent would
   * silently fork what readers render). They still get Delete and Announce:
   * both act on the record as a whole, in the writer's own repo. Our own
   * union does not make a post read-only — see ~/lib/document-content.
   */
  editable: boolean;
  /**
   * The Bluesky post announcing this document, from the record's bskyPostRef
   * strongRef (written back after a successful announce — works for any app
   * that fills the field, not just ours). null = never announced, or the ref
   * is malformed. The post may since have been deleted on Bluesky; we link
   * honestly to where it was and keep "Announce again" available.
   */
  announced: { did: string; postRkey: string } | null;
};

/** bskyPostRef → the announce link parts, or null. Only app.bsky.feed.post
 * refs count — the field is untrusted network data and could point anywhere. */
function announcedFromRef(
  ref: StandardDocument["bskyPostRef"],
): DashboardRow["announced"] {
  if (typeof ref?.uri !== "string") return null;
  const parts = parseAtUri(ref.uri);
  if (parts?.collection !== "app.bsky.feed.post") return null;
  return { did: parts.did, postRkey: parts.rkey };
}

/** Maps + sorts (newest first, by publishedAt then rkey) and drops records
 * without a usable rkey. Untitled records stay visible — they're still
 * deletable — under a placeholder title.
 *
 * `did` is what turns a cover blob into a servable /img path; omit it and
 * every row simply comes back cover-less (the monogram fallback covers that
 * case anyway), so callers that only need titles and dates can skip it. */
export function mapDashboardRows(
  records: ListedRecord<StandardDocument>[],
  did?: string,
): DashboardRow[] {
  return records
    .flatMap((r) => {
      const rkey = rkeyFromUri(r.uri);
      if (!rkey) return [];
      const coverCid = did ? coverImageCid(r.value.coverImage) : null;
      const body = documentBodyMarkdown(r.value);
      return [
        {
          rkey,
          coverPath: did && coverCid ? blobImagePath(did, coverCid) : null,
          // Bounded scan: this loop can see a full page of third-party
          // records, so it takes the list-sized reading-time budget.
          readingMinutes: listItemReadingMinutes(body),
          title:
            typeof r.value.title === "string" && r.value.title.trim() !== ""
              ? r.value.title
              : "(untitled)",
          description:
            typeof r.value.description === "string" &&
            r.value.description.trim() !== ""
              ? r.value.description
              : null,
          publishedAt:
            typeof r.value.publishedAt === "string"
              ? r.value.publishedAt
              : null,
          updatedAt:
            typeof r.value.updatedAt === "string" ? r.value.updatedAt : null,
          editable: !hasForeignContent(r.value),
          announced: announcedFromRef(r.value.bskyPostRef),
        },
      ];
    })
    .sort(
      (a, b) =>
        Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") ||
        (a.rkey < b.rkey ? 1 : -1),
    );
}

export type PostViews = { rkey: string; title: string; views: number };

/**
 * Joins /api/stats' per-path view counts onto this writer's own dashboard
 * rows (path→rkey, derived the same way the reading surface builds a post's
 * URL: `/@{ident}/{rkey}`). A row with no matching path is left OUT of the
 * result rather than shown with 0 views: cookieless analytics genuinely miss
 * some readers, and older posts may predate the stats seam entirely —
 * absence isn't the same claim as zero.
 */
export function joinStatsToRows(
  rows: DashboardRow[],
  paths: Array<{ path: string; views: number }>,
  ident: string,
): PostViews[] {
  const viewsByPath = new Map(paths.map((p) => [p.path, p.views]));
  return rows.flatMap((row) => {
    const views = viewsByPath.get(`/@${ident}/${row.rkey}`);
    return views === undefined
      ? []
      : [{ rkey: row.rkey, title: row.title, views }];
  });
}

/** The same join as above, keyed for a row-by-row lookup. Built ON TOP of
 * joinStatsToRows rather than beside it so the absence rule — a post the
 * stats provider never mentioned is missing from the map, not present with
 * 0 — can only ever be defined in one place. */
export function viewsByRkey(
  rows: DashboardRow[],
  paths: Array<{ path: string; views: number }>,
  ident: string,
): Map<string, number> {
  return new Map(
    joinStatsToRows(rows, paths, ident).map((p) => [p.rkey, p.views]),
  );
}

/** The posts manager's three work states: out, queued, and in progress. */
export type PostsTab = "published" | "drafts" | "scheduled";

/**
 * The tablist's keyboard map — the ARIA tabs pattern's arrow keys, as a pure
 * function of the visible strip. Returns the tab a key should move to, or null
 * for a key the tablist doesn't own, so the caller only swallows keys it
 * actually handled (Tab, typing, and browser shortcuts stay the browser's).
 *
 * Wrapping in both directions is deliberate: the strip is a ring of two or
 * three items, and a dead end at either edge is exactly how a keyboard user
 * concludes a tab can't be reached at all.
 *
 * `tabs` is the VISIBLE order rather than the type's three states, because
 * Scheduled comes and goes with the queue and the keys have to walk what is
 * actually on screen.
 */
export function nextPostsTab(
  key: string,
  tabs: PostsTab[],
  current: PostsTab,
): PostsTab | null {
  if (tabs.length === 0) return null;
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs[tabs.length - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const at = tabs.indexOf(current);
  // A selected tab that isn't in the visible strip can't be stepped from; the
  // ring starts at its head so the keys still go somewhere real.
  if (at === -1) return tabs[0];
  const delta = key === "ArrowRight" ? 1 : -1;
  return tabs[(at + delta + tabs.length) % tabs.length];
}

/** Column ids the manager sorts by. Kept as constants because they're the
 * contract between the column definitions and the sort control. */
export const DATE_COLUMN = "date";
export const VIEWS_COLUMN = "views";

/**
 * The manager's sort choices. "most-read" is offered ONLY while the stats
 * seam is answering — a sort by a metric we don't have would silently do
 * nothing, which is worse than not offering it.
 */
export const POST_SORTS = ["newest", "oldest", "most-read"] as const;

export type PostSort = (typeof POST_SORTS)[number];

/** The sort a writer gets when they haven't asked for one. */
export const DEFAULT_POST_SORT: PostSort = "newest";

/**
 * Narrow an arbitrary string to a sort choice.
 *
 * The select's `value` is a `string` as far as the DOM is concerned, and it was
 * being asserted into a `PostSort` — an assertion the compiler cannot check and
 * that would have quietly handed the table a sort id it has no column for.
 * "most-read" is a real case of this rather than a hypothetical: the option is
 * only rendered while the stats seam is answering, so it can vanish from under
 * a selection.
 */
export function parsePostSort(value: string): PostSort {
  return POST_SORTS.find((sort) => sort === value) ?? DEFAULT_POST_SORT;
}

/** Sort choice → the table's sorting state. One mapping, so the select and
 * the table can't disagree about what "oldest" means. */
export function sortingStateFor(
  sort: PostSort,
): Array<{ id: string; desc: boolean }> {
  if (sort === "most-read") return [{ id: VIEWS_COLUMN, desc: true }];
  return [{ id: DATE_COLUMN, desc: sort === "newest" }];
}

/**
 * One row in the manager's Scheduled tab — a post that hasn't gone out yet,
 * either because its time hasn't come or because something went wrong.
 *
 * `lastError` is the sentence the cron wrote when it couldn't publish
 * (~/lib/scheduled-publish), rendered verbatim: it was written for this writer
 * to read, and paraphrasing it here would be a second copy of the same message
 * free to drift from the one in the database.
 *
 * `description: null` is carried for the same reason DraftRow carries it — so a
 * scheduled post flows through the one title/dek search filter the published
 * list and the public archive already use.
 */
export type ScheduledPostRow = {
  id: string;
  draftId: string;
  /** ISO UTC. The writer's own zone is applied in the browser — see
   * ~/components/scheduled-time. */
  dueAt: string;
  status: "pending" | "failed";
  attempts: number;
  lastError: string | null;
  title: string;
  description: null;
};

/** One draft row in the manager's Drafts tab. `description: null` is carried
 * deliberately: it lets drafts flow through the same title/dek search filter
 * the published list and the public archive use. */
export type DraftRow = {
  id: string;
  title: string;
  /** ISO string — loader data must serialize identically on both sides. */
  updatedAt: string;
  description: null;
};
