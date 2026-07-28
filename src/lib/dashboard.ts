/**
 * Dashboard row mapping — pure record → view-model transform over the
 * writer's own site.standard.document listRecords page (untrusted shapes).
 */
import {
  type ListedRecord,
  parseAtUri,
  rkeyFromUri,
  type StandardDocument,
} from "~/lib/atproto";

export type DashboardRow = {
  rkey: string;
  title: string;
  /** Excerpt shown under the title — scanability on long lists. */
  description: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  /**
   * Rich-content-union documents (e.g. Leaflet's pub.leaflet.content) are not
   * editable here (editing only textContent would silently fork what readers
   * render). They still get Delete and Announce: both act on
   * the record as a whole, in the writer's own repo.
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
 * deletable — under a placeholder title. */
export function mapDashboardRows(
  records: ListedRecord<StandardDocument>[],
): DashboardRow[] {
  return records
    .flatMap((r) => {
      const rkey = rkeyFromUri(r.uri);
      if (!rkey) return [];
      return [
        {
          rkey,
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
          editable: r.value.content == null,
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
