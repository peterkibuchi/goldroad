/**
 * The posts manager — the writer's content workbench, and the only surface
 * whose job is "find and act on a piece of my writing".
 *
 * Three tabs, one per work state a writer actually has: Published (their repo),
 * Scheduled (queued in our D1, plus anything that failed on its way out) and
 * Drafts (our D1). The Scheduled tab is the answer to "did it go out?" — a
 * question a writer must never have to guess at, which is why a failed schedule
 * appears here with the cron's own reason on it and a button that publishes it
 * this second.
 *
 * Sorting, searching and the row models are TanStack Table's, driven headless:
 * the library owns the row pipeline, this file owns every pixel. The rows are
 * a list, not a data grid — a five-column table would be unreadable on a
 * phone and these rows are summaries, not cells — so nothing here renders a
 * <table>, which is precisely what "headless" buys.
 *
 * PAGINATION, HONESTLY. Posts arrive from the writer's PDS one cursor page at
 * a time, so there are two layers and only one of them can reach a record we
 * haven't fetched:
 *   - the PDS cursor ("Older posts →") is the real pagination, and it is the
 *     only thing that can load records we don't have;
 *   - the table runs in `manualPagination` mode over the page already loaded,
 *     which is TanStack Table's contract for exactly this arrangement — it
 *     sorts and filters what's here and never pretends to page beyond it.
 * Search therefore covers the loaded page, and the UI says so whenever more
 * pages exist rather than letting a writer conclude a post was deleted
 * because a search didn't surface it.
 */
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  type ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { drizzle } from "drizzle-orm/d1";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatDate } from "~/components/document-article";
import { ExternalLink } from "~/components/external-link";
import { SearchIcon } from "~/components/icons";
import { MovePublicationNotice } from "~/components/move-publication-notice";
import { Notice } from "~/components/notice";
import { PostMetrics, PostThumb } from "~/components/post-summary";
import { ScheduledTime } from "~/components/scheduled-time";
import { AppShell } from "~/components/site-chrome";
import { matchesPostQuery } from "~/lib/archive";
import {
  isValidCursor,
  listRecords,
  listRecordsPage,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import {
  DATE_COLUMN,
  type DashboardRow,
  type DraftRow,
  mapDashboardRows,
  nextPostsTab,
  type PostSort,
  type PostsTab,
  type ScheduledPostRow,
  sortingStateFor,
  VIEWS_COLUMN,
  viewsByRkey,
} from "~/lib/dashboard";
import { listDrafts } from "~/lib/drafts";
import {
  bskyPostUrl,
  type DocumentEngagement,
  getPostsEngagement,
} from "~/lib/engagement";
import { readLiveSessionDid } from "~/lib/live-session";
import { LEGACY_ORIGINS, ownOrigins } from "~/lib/origin";
import { capture } from "~/lib/posthog";
import { isOwnPublicationUrl, TID_RE } from "~/lib/publish";
import { formatReadingTime } from "~/lib/reading-time";
import { selectWriterSchedule } from "~/lib/scheduled-posts";
import { useWriterStats } from "~/lib/use-writer-stats";
import { cn } from "~/lib/utils";
import { env } from "cloudflare:workers";

const ERROR_MESSAGES: Record<string, string> = {
  missing_rkey: "That action was missing its post. Try again from this page.",
  not_found: "That post isn't in your repo anymore.",
  delete_scope:
    "Deleting needs a permission your current sign-in doesn't include yet — re-connect your account to enable deletion.",
  announce_scope:
    "Posting to Bluesky needs a permission your current sign-in doesn't include yet — re-connect your account to enable announcing.",
  announce_no_url:
    "This post has no public URL to announce — it may belong to a publication Goldroad can't resolve right now.",
  move_no_publication:
    "There's no publication to move yet — it's created when you publish your first post.",
  schedule_in_flight:
    "That post is publishing right now — give it a moment and refresh to see it.",
  schedule_no_draft:
    "That scheduled post's draft couldn't be found, so there was nothing to publish.",
  draft_not_found:
    "That draft isn't in your drafts anymore, so there was nothing to publish.",
  unschedule_failed:
    "That schedule couldn't be cancelled just now. Try again in a moment.",
  missing_title:
    "That draft has no title, so it couldn't be published. Open it, give it a title, and schedule it again.",
  // Named ahead of the prefix fallbacks below, which would print the raw code.
  "move_failed:publication_unreadable":
    "We couldn't reach your publication just now, so nothing was moved. Refresh the page and try again.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  const named = ERROR_MESSAGES[code];
  if (named) return named;
  if (code.startsWith("delete_failed:"))
    return `Deleting failed (${code.slice("delete_failed:".length)}). Try again.`;
  if (code.startsWith("announce_failed:"))
    return `Announcing failed (${code.slice("announce_failed:".length)}). Try again.`;
  if (code.startsWith("move_failed:"))
    return `Moving your publication failed (${code.slice("move_failed:".length)}). Try again.`;
  if (code.startsWith("publish_failed:"))
    return `Publishing failed (${code.slice("publish_failed:".length)}). Your draft is safe — try again, or schedule it for later.`;
  return "Something went wrong. Try again.";
}

/** Scope errors are fixed by a fresh sign-in (new consent = new scope grant). */
function needsReconnect(code: string | undefined): boolean {
  return code === "delete_scope" || code === "announce_scope";
}

const getDashboard = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string }) => ({
    cursor: isValidCursor(data.cursor) ? data.cursor : undefined,
  }))
  .handler(async ({ data }) => {
    const request = getRequest();
    const did = await readLiveSessionDid(
      request,
      env.COOKIE_SECRET,
      drizzle(env.DB),
    );
    if (!did) return null;
    const origin = new URL(request.url).origin;
    const handle = await resolveDidToHandle(did).catch(() => null);
    // The writer's own documents, straight from their PDS over public XRPC —
    // same read path the public publication page uses. A failed load stays
    // distinguishable from "no posts yet" (rows: null) so we never greet a
    // writer whose PDS flaked with a scary empty state.
    const pds = await resolveDidToPds(did).catch(() => null);
    // The PDS fan-out and the D1 drafts read run in one parallel batch —
    // neither depends on the other, so the page pays the slowest, not the sum.
    const [draftRows, scheduleRows, [page, onLegacyUrl]] = await Promise.all([
      // The writer's private drafts, from our own D1 (they are never in the
      // repo — see /api/drafts). A failed read stays distinguishable from
      // "no drafts" (null, same policy as rows) so the section can say so
      // instead of implying the writer's drafts vanished.
      listDrafts(drizzle(env.DB), did).catch(() => null),
      // The writer's queue: pending posts and anything that failed on its way
      // out. Same null-means-the-read-flaked policy as the drafts above — an
      // empty Scheduled tab must mean "nothing queued", never "we couldn't
      // tell", because the difference between those is whether a post of
      // theirs is going out.
      selectWriterSchedule(drizzle(env.DB), did).catch(() => null),
      pds
        ? Promise.all([
            listRecordsPage<StandardDocument>(
              pds,
              did,
              "site.standard.document",
              { cursor: data.cursor },
            ).catch(() => null),
            // Move-to-canonical affordance: is the writer's own publication still
            // on a legacy origin? Best-effort — a flaked read just hides the notice.
            listRecords<StandardPublication>(
              pds,
              did,
              "site.standard.publication",
              { reverse: true },
            )
              .then((pubs) => {
                const own = pubs.find((p) =>
                  isOwnPublicationUrl(p.value.url, ownOrigins(origin)),
                );
                return own
                  ? isOwnPublicationUrl(own.value.url, LEGACY_ORIGINS)
                  : false;
              })
              .catch(() => false),
          ])
        : ([null, false] as const),
    ]);
    const rows = page ? mapDashboardRows(page.records, did) : null;
    // Cross-network counts for this page's announced posts: one batched,
    // edge-cached AppView call rather than one per row. It costs the page a
    // round trip on a cold cache, which is the same trade the public reading
    // surfaces already make; it can never fail the page.
    const engagement = rows
      ? await getPostsEngagement(
          // Rebuilt from the row's already-validated announce parts rather
          // than re-reading the raw record: same value, and it can't drift
          // from what the row's "Announced ↗" link points at.
          rows.flatMap((row) =>
            row.announced
              ? [
                  {
                    key: row.rkey,
                    ref: {
                      uri: `at://${row.announced.did}/app.bsky.feed.post/${row.announced.postRkey}`,
                    },
                  },
                ]
              : [],
          ),
        ).catch(() => new Map<string, DocumentEngagement>())
      : new Map<string, DocumentEngagement>();
    return {
      ident: handle ?? did,
      handle,
      rows,
      // Maps don't survive the loader's serialization — send plain entries.
      engagement: [...engagement],
      nextCursor: page?.cursor ?? null,
      onLegacyUrl,
      // ISO strings, not Dates: loader data must serialize identically on
      // server and client. null = the read flaked (not "no drafts").
      drafts:
        draftRows?.map((d) => ({
          id: d.id,
          title: d.title,
          updatedAt: d.updatedAt.toISOString(),
          description: null,
        })) ?? null,
      scheduled:
        scheduleRows?.map((row) => ({
          id: row.id,
          draftId: row.draftId,
          dueAt: row.dueAt.toISOString(),
          // The query returns pending and failed rows only.
          status:
            row.status === "failed"
              ? ("failed" as const)
              : ("pending" as const),
          attempts: row.attempts,
          lastError: row.lastError,
          // The join is a LEFT join: a row whose draft vanished still has to be
          // nameable, because it is the row the writer most needs to see.
          title: row.title?.trim() || "(untitled draft)",
          description: null,
        })) ?? null,
    };
  });

export const Route = createFileRoute("/dashboard")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: {
      error?: string;
      published?: string;
      announced?: string;
      deleted?: boolean;
      moved?: boolean;
      scheduled?: boolean;
      unscheduled?: boolean;
      cursor?: string;
      tab?: PostsTab;
    } = {};
    if (typeof search.error === "string") out.error = search.error;
    // rkeys get interpolated into URLs below — only accept well-formed TIDs.
    if (typeof search.published === "string" && TID_RE.test(search.published))
      out.published = search.published;
    if (typeof search.announced === "string" && TID_RE.test(search.announced))
      out.announced = search.announced;
    if (search.deleted === "1" || search.deleted === 1) out.deleted = true;
    if (search.moved === "1" || search.moved === 1) out.moved = true;
    if (search.scheduled === "1" || search.scheduled === 1)
      out.scheduled = true;
    if (search.unscheduled === "1" || search.unscheduled === 1)
      out.unscheduled = true;
    if (isValidCursor(search.cursor)) out.cursor = search.cursor;
    // The tab is a real address so the overview can link straight to drafts,
    // and so scheduling can land the writer on their queue.
    if (
      search.tab === "drafts" ||
      search.tab === "published" ||
      search.tab === "scheduled"
    )
      out.tab = search.tab;
    return out;
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ deps }) => {
    const dashboard = await getDashboard({ data: { cursor: deps.cursor } });
    // Unauthed → /write, which renders the sign-in form; it sends the writer
    // back here once they're in, not into the editor.
    if (!dashboard)
      throw redirect({ to: "/write", search: { returnTo: "/dashboard" } });
    return dashboard;
  },
  head: () => ({
    meta: [
      { title: "Your posts — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DashboardPage,
});

const ANNOUNCE_EXPLAINER =
  "Share this post to your Bluesky followers — it appears as a rich card linking here.";

/** Shared shape for the inline actions on a row and in the notices. */
const INLINE_ACTION =
  "-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink";
const DESTRUCTIVE_ACTION =
  "-my-2 inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-spot";

function AnnounceButton({
  rkey,
  label,
  confirmMessage,
}: {
  rkey: string;
  label?: string;
  /** Set on already-announced posts: re-announcing is legal but deliberate. */
  confirmMessage?: string;
}) {
  return (
    <form
      action="/api/publish"
      className="inline"
      method="post"
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage))
          event.preventDefault();
      }}
    >
      <input name="intent" type="hidden" value="announce" />
      <input name="rkey" type="hidden" value={rkey} />
      <button
        className={cn(INLINE_ACTION, "cursor-pointer")}
        title={ANNOUNCE_EXPLAINER}
        type="submit"
      >
        {label ?? "Announce on Bluesky"}
      </button>
    </form>
  );
}

/**
 * Confirm-before-delete for a published post. Non-announced posts keep the
 * plain window.confirm. Announced posts get a real dialog instead: deleting
 * the document does NOT delete the Bluesky announcement (a separate record
 * in the writer's repo), so its card would point at a page that no longer
 * exists — that consequence needs plain words and a direct link to the
 * Bluesky post, which a confirm() line can't carry.
 * Exported for tests (dashboard-delete.test.tsx) — not a route.
 */
export function DeletePostForm({
  rkey,
  title,
  announced,
}: {
  rkey: string;
  title: string;
  announced: { did: string; postRkey: string } | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Set when the dialog's Delete button approved the submit, so the
  // re-entrant requestSubmit below passes straight through this handler.
  const approvedRef = useRef(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (approvedRef.current) return;
    if (announced) {
      event.preventDefault();
      dialogRef.current?.showModal();
      // Focus lands on the safe action, not the destructive one (or the
      // link, which showModal would otherwise pick as first-focusable).
      cancelRef.current?.focus();
      return;
    }
    if (
      !window.confirm(`Delete "${title}" from your repo? This can't be undone.`)
    )
      event.preventDefault();
  }

  return (
    <>
      <form
        action="/api/publish"
        className="inline"
        method="post"
        onSubmit={handleSubmit}
        ref={formRef}
      >
        <input name="intent" type="hidden" value="delete" />
        <input name="rkey" type="hidden" value={rkey} />
        <button className={DESTRUCTIVE_ACTION} type="submit">
          Delete
        </button>
      </form>
      {announced && (
        /* Native <dialog>: showModal gives the focus trap, Esc-to-close, and
           inert background for free. */
        <dialog
          aria-describedby={`delete-desc-${rkey}`}
          aria-labelledby={`delete-title-${rkey}`}
          className="m-auto w-full max-w-md border-2 border-ink bg-paper p-6 text-ink backdrop:bg-ink/50"
          ref={dialogRef}
          role="alertdialog"
        >
          <h2
            className="font-black font-display text-ink text-xl tracking-tight"
            id={`delete-title-${rkey}`}
          >
            Delete "{title}"?
          </h2>
          <p
            className="mt-3 text-ink-soft leading-relaxed"
            id={`delete-desc-${rkey}`}
          >
            This deletes the post from your repo — it can't be undone. Your
            announcement on Bluesky is a separate post and stays up: its card
            will point to a page that no longer exists.
          </p>
          <p className="mt-2 font-display text-sm">
            <ExternalLink
              className="underline underline-offset-2 transition-colors hover:text-spot"
              href={bskyPostUrl(announced.did, announced.postRkey)}
            >
              View the Bluesky post
            </ExternalLink>{" "}
            <span className="text-ink-soft">
              — you can delete it there too.
            </span>
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              className="min-h-11 cursor-pointer bg-spot px-6 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
              onClick={() => {
                approvedRef.current = true;
                dialogRef.current?.close();
                formRef.current?.requestSubmit();
                // The submit event dispatches synchronously above; re-arm the
                // confirm in case the navigation never happens (network fail).
                approvedRef.current = false;
              }}
              type="button"
            >
              Delete the post
            </button>
            <button
              className="min-h-11 cursor-pointer font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              onClick={() => dialogRef.current?.close()}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}

/** A published row with whatever quick metrics we actually have for it.
 * `views` undefined and `engagement` null both mean "nothing to say" — they
 * are never rendered as zero. */
type ManagerRow = DashboardRow & {
  views?: number;
  engagement: DocumentEngagement | null;
};

/**
 * The row pipeline both tabs share: TanStack Table in headless, controlled
 * mode. `manualPagination` declares that paging is somebody else's job (the
 * PDS cursor's), so the table sorts and filters the loaded set and leaves the
 * page boundary alone.
 */
function useManagerTable<
  T extends { title: string; description: string | null },
>(
  data: T[],
  columns: ColumnDef<T, unknown>[],
  sorting: SortingState,
  globalFilter: string,
) {
  return useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    // One definition of "matches", shared with the public archive's search.
    globalFilterFn: (row, _columnId, value: string) =>
      matchesPostQuery(row.original, value),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
    rowCount: data.length,
  });
}

/** Quiet uppercase section label — the same one the drafts list and the
 * archive already use, so writer surfaces keep one heading voice. */
function SectionRule({
  children,
  id,
}: {
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <p
      className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
      id={id}
    >
      {children}
    </p>
  );
}

function TabButton({
  active,
  count,
  label,
  onSelect,
  panelId,
  tabId,
}: {
  active: boolean;
  /** Omitted when a count would be a lie (a paginated list shows a page). */
  count?: number;
  label: string;
  onSelect: () => void;
  panelId: string;
  tabId: string;
}) {
  return (
    <button
      aria-controls={panelId}
      aria-selected={active}
      className={cn(
        "-mb-px inline-flex min-h-11 cursor-pointer items-center gap-2 border-b-2 px-1 font-display text-sm transition-colors",
        active
          ? "border-ink font-bold text-ink"
          : "border-transparent text-ink-soft hover:text-ink",
      )}
      id={tabId}
      onClick={onSelect}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {label}
      {/* A zero is left off: "Drafts" with nothing after it already says
          there are none, and a lone 0 reads as a broken counter. */}
      {count !== undefined && count > 0 && (
        <span className="font-normal tabular-nums">{count}</span>
      )}
    </button>
  );
}

/**
 * The manager itself, separated from the route so it can be rendered — and
 * tested — without a router. `tab` is lifted to the route, where it lives in
 * the URL; everything else (query, sort) is view state that belongs to this
 * component.
 */
export function PostsManager({
  ident,
  rows,
  engagement,
  drafts,
  scheduled,
  cursor,
  nextCursor,
  tab,
  onTabChange,
}: {
  ident: string;
  /** null = the PDS read flaked. Never the same claim as "no posts". */
  rows: DashboardRow[] | null;
  engagement: Map<string, DocumentEngagement>;
  /** null = the drafts read flaked. */
  drafts: DraftRow[] | null;
  /** Queued and failed posts; null = the read flaked. */
  scheduled: ScheduledPostRow[] | null;
  cursor?: string;
  nextCursor: string | null;
  tab: PostsTab;
  onTabChange: (tab: PostsTab) => void;
}) {
  const stats = useWriterStats();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PostSort>("newest");

  // A view count exists only where the analytics provider recorded that exact
  // path; every other row keeps `undefined`, which renders as nothing.
  const views = useMemo(
    () =>
      stats.status === "ready"
        ? viewsByRkey(rows ?? [], stats.paths, ident)
        : new Map<string, number>(),
    [rows, stats, ident],
  );
  const canSortByViews = views.size > 0;

  const postRows = useMemo<ManagerRow[]>(
    () =>
      (rows ?? []).map((row) => ({
        ...row,
        views: views.get(row.rkey),
        engagement: engagement.get(row.rkey) ?? null,
      })),
    [rows, views, engagement],
  );

  const postColumns = useMemo<ColumnDef<ManagerRow, unknown>[]>(
    () => [
      // The only globally-filtered column: the filter reads the whole row, so
      // letting every column run it would just repeat identical work.
      { id: "post", accessorFn: (row) => row.title, enableGlobalFilter: true },
      {
        id: DATE_COLUMN,
        accessorFn: (row) =>
          row.publishedAt ? Date.parse(row.publishedAt) : undefined,
        enableGlobalFilter: false,
        // Undated records sort to the end either way rather than pretending
        // to be the oldest thing the writer ever published.
        sortUndefined: "last",
      },
      {
        id: VIEWS_COLUMN,
        accessorFn: (row) => row.views,
        enableGlobalFilter: false,
        // Absence is not a low score: posts the provider never recorded park
        // at the end of a most-read sort instead of below the zero-view ones.
        sortUndefined: "last",
      },
    ],
    [],
  );

  const draftColumns = useMemo<ColumnDef<DraftRow, unknown>[]>(
    () => [
      { id: "post", accessorFn: (row) => row.title, enableGlobalFilter: true },
      {
        id: DATE_COLUMN,
        accessorFn: (row) => Date.parse(row.updatedAt),
        enableGlobalFilter: false,
        sortUndefined: "last",
      },
    ],
    [],
  );

  // Drafts have no readers, so "most read" has no meaning there — it falls
  // back to newest rather than silently doing nothing.
  const draftSort: PostSort = sort === "most-read" ? "newest" : sort;
  const postsTable = useManagerTable(
    postRows,
    postColumns,
    sortingStateFor(sort),
    query,
  );
  const draftsTable = useManagerTable(
    drafts ?? [],
    draftColumns,
    sortingStateFor(draftSort),
    query,
  );

  // The queue is chronological BY NATURE — soonest first, straight from the
  // query — so it doesn't run through the table's sort control; a "newest first"
  // queue would put next year's post above tomorrow's. Search still applies,
  // through the same matcher the other two tabs and the public archive use.
  const visibleScheduled = (scheduled ?? []).filter((row) =>
    matchesPostQuery(row, query),
  );
  const failedCount = (scheduled ?? []).filter(
    (row) => row.status === "failed",
  ).length;

  // The Scheduled tab comes and goes with the queue (see the tablist below),
  // so the strip's order is derived once here and used by both the buttons and
  // the arrow keys — they can't disagree about what "the next tab" is.
  const showScheduled =
    tab === "scheduled" || scheduled === null || scheduled.length > 0;
  const tabOrder: PostsTab[] = showScheduled
    ? ["published", "scheduled", "drafts"]
    : ["published", "drafts"];

  /**
   * The keyboard half of the tabs pattern. Without it the roving tabindex on
   * TabButton is a trap rather than a convenience: only the selected tab is
   * tabbable, so a keyboard-only writer could reach Published and nothing
   * else — Scheduled, the tab that answers "did it go out?", would need a
   * hand-typed `?tab=scheduled`.
   *
   * Automatic activation (focus moves AND selects) rather than the manual
   * variant: every panel is already rendered and switching is a URL replace,
   * so arriving costs nothing and a second keypress to confirm would be
   * ceremony. Keys the tablist doesn't own are left to the browser.
   */
  function handleTabKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    const next = nextPostsTab(event.key, tabOrder, tab);
    if (!next) return;
    // Arrows would otherwise scroll the list behind the strip.
    event.preventDefault();
    const tablist = event.currentTarget;
    onTabChange(next);
    // The target button is already in the DOM — only its tabindex changes when
    // the selection lands — so focus doesn't wait for the re-render.
    tablist.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus();
  }

  const isSearching = query.trim() !== "";
  const paginated = Boolean(cursor || nextCursor);
  const visiblePosts = postsTable.getRowModel().rows;
  const visibleDrafts = draftsTable.getRowModel().rows;
  const firstRun =
    rows !== null &&
    rows.length === 0 &&
    drafts !== null &&
    drafts.length === 0 &&
    (scheduled === null || scheduled.length === 0);

  return (
    <>
      {/* Tabs are the manager's spine: one job per tab, and no tab for a
          feature that doesn't exist. */}
      <div className="mt-8 border-rule border-b">
        <div
          aria-label="Post lists"
          // Scrolls rather than shrinks at 320: three tabs with their counts
          // min-content to ~266px and flex items don't shrink below that, so a
          // fixed row pushed the whole document wider than the phone. Only
          // visible once a writer has queued something — the Scheduled tab is
          // conditional, so a two-tab account fits and this shipped looking fine.
          className="flex gap-4 overflow-x-auto sm:gap-6"
          onKeyDown={handleTabKeys}
          role="tablist"
        >
          <TabButton
            active={tab === "published"}
            // A page count dressed as a total would be a lie; a complete list
            // is honestly countable.
            count={rows !== null && !paginated ? rows.length : undefined}
            label="Published"
            onSelect={() => onTabChange("published")}
            panelId="panel-published"
            tabId="tab-published"
          />
          {/* The Scheduled tab is only furniture when nothing is queued — but
              it appears the moment something is, and it appears FIRST among the
              unpublished states, because a post about to go out is more urgent
              than a draft that isn't.
              It also appears whenever this tab is the SELECTED one, even with an
              empty or unreadable queue: `tab=scheduled` is validated URL state
              that both scheduling and cancelling redirect to, and a selected tab
              with no button leaves the panel's aria-labelledby pointing at
              nothing and no visible mark of where the writer is. */}
          {showScheduled && (
            <TabButton
              active={tab === "scheduled"}
              count={scheduled?.length}
              label={failedCount > 0 ? "Scheduled ·" : "Scheduled"}
              onSelect={() => onTabChange("scheduled")}
              panelId="panel-scheduled"
              tabId="tab-scheduled"
            />
          )}
          <TabButton
            active={tab === "drafts"}
            count={drafts?.length}
            label="Drafts"
            onSelect={() => onTabChange("drafts")}
            panelId="panel-drafts"
            tabId="tab-drafts"
          />
        </div>
      </div>

      {/* Search + sort. Hidden on a genuinely empty account, where there is
          nothing to search and the controls would be furniture. */}
      {!firstRun && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <label className="flex min-h-9 items-center gap-2 border-rule border-b pb-1 text-ink-soft focus-within:border-ink">
            <SearchIcon className="h-4 w-4 shrink-0" />
            <span className="sr-only">Search your posts by title</span>
            {/* 16px at base, the denser 14px from `sm:` up: iOS Safari zooms
                the page in when a focused control computes under 16px and
                never zooms back out, which would leave a writer tapping
                Search on a zoomed, horizontally-panning posts manager. */}
            <input
              className="w-40 bg-transparent font-display text-base text-ink placeholder:text-ink-soft/60 focus:outline-none sm:w-56 sm:text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles"
              type="search"
              value={query}
            />
          </label>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex min-h-9 items-center gap-2 font-display text-ink-soft text-sm">
              <span>Sort</span>
              {/* Same 16px floor as the search field above. */}
              <select
                className="cursor-pointer border-rule border-b bg-transparent pb-1 font-display text-base text-ink focus:outline-none sm:text-sm"
                onChange={(event) => setSort(event.target.value as PostSort)}
                value={sort}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                {/* Only offered once there are counts to sort by — a sort that
                    can't move anything is a dead control. */}
                {canSortByViews && <option value="most-read">Most read</option>}
              </select>
            </label>
            {/* Import lives here, not in the rail: it's something you do to
                your archive — occasionally, from the place your archive is —
                rather than a destination you navigate to. Secondary weight,
                because the toolbar's job is the list beneath it. The ellipsis
                is the old menu convention: this opens a further step, it
                doesn't import anything on click. A genuinely empty account
                never sees this toolbar, so `FirstRun` keeps its own import
                link, as does the overview's next-action row. */}
            <a
              className="inline-flex min-h-11 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href="/import"
            >
              Import…
            </a>
          </div>
        </div>
      )}

      <div
        aria-labelledby="tab-published"
        hidden={tab !== "published"}
        id="panel-published"
        role="tabpanel"
      >
        {rows === null ? (
          <Notice tone="alert">
            Your posts couldn't be loaded right now — your data server may be
            briefly unreachable. They're safe in your repo; refresh to try
            again.
          </Notice>
        ) : firstRun ? (
          <FirstRun />
        ) : rows.length === 0 ? (
          <p className="mt-8 text-ink-soft leading-relaxed">
            Nothing published yet — your drafts are on the{" "}
            <button
              className="cursor-pointer underline underline-offset-2 transition-colors hover:text-ink"
              onClick={() => onTabChange("drafts")}
              type="button"
            >
              Drafts tab
            </button>
            .
          </p>
        ) : visiblePosts.length === 0 ? (
          <p className="mt-8 text-ink-soft leading-relaxed">
            No posts on this page match "{query.trim()}".
          </p>
        ) : (
          <>
            <p className="mt-6 font-display text-ink-soft text-xs">
              {visiblePosts.length}{" "}
              {visiblePosts.length === 1 ? "post" : "posts"}
              {/* An honest scope: a paginated view holds a page, and search
                  can only see what's been fetched. */}
              {paginated
                ? isSearching
                  ? " on this page"
                  : " on this page — older posts load below"
                : ""}
            </p>
            <ul className="mt-2">
              {visiblePosts.map(({ original: row }) => (
                <PublishedRow ident={ident} key={row.rkey} row={row} />
              ))}
            </ul>
            {nextCursor && (
              <p className="mt-6">
                <a
                  className="font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                  href={`/dashboard?cursor=${encodeURIComponent(nextCursor)}`}
                >
                  Older posts →
                </a>
              </p>
            )}
          </>
        )}
      </div>

      <div
        aria-labelledby="tab-scheduled"
        hidden={tab !== "scheduled"}
        id="panel-scheduled"
        role="tabpanel"
      >
        {scheduled === null ? (
          <Notice tone="alert">
            Your scheduled posts couldn't be loaded right now, so this list
            isn't the whole story — refresh to try again. Anything queued is
            still queued.
          </Notice>
        ) : scheduled.length === 0 ? (
          <p className="mt-8 text-ink-soft leading-relaxed">
            Nothing scheduled. You can set a date and time when you write —
            press{" "}
            <a
              className="underline underline-offset-2 transition-colors hover:text-ink"
              href="/write"
            >
              New post
            </a>{" "}
            and look beside Publish.
          </p>
        ) : visibleScheduled.length === 0 ? (
          <p className="mt-8 text-ink-soft leading-relaxed">
            No scheduled posts match "{query.trim()}".
          </p>
        ) : (
          <>
            <SectionRule>
              {visibleScheduled.length}{" "}
              {visibleScheduled.length === 1 ? "post" : "posts"} waiting
              {failedCount > 0
                ? ` · ${failedCount} didn't go out`
                : " · soonest first"}
            </SectionRule>
            <ul>
              {visibleScheduled.map((row) => (
                <ScheduledListRow key={row.id} row={row} />
              ))}
            </ul>
          </>
        )}
      </div>

      <div
        aria-labelledby="tab-drafts"
        hidden={tab !== "drafts"}
        id="panel-drafts"
        role="tabpanel"
      >
        {drafts === null ? (
          <Notice tone="alert">
            Your drafts couldn't be loaded right now — they're safe; refresh to
            try again.
          </Notice>
        ) : drafts.length === 0 ? (
          <p className="mt-8 text-ink-soft leading-relaxed">
            No drafts in progress.{" "}
            <a
              className="underline underline-offset-2 transition-colors hover:text-ink"
              href="/write"
            >
              Start something new
            </a>{" "}
            — a draft is private to you until you publish it.
          </p>
        ) : visibleDrafts.length === 0 ? (
          <p className="mt-8 text-ink-soft leading-relaxed">
            No drafts match "{query.trim()}".
          </p>
        ) : (
          <>
            <SectionRule>
              {visibleDrafts.length}{" "}
              {visibleDrafts.length === 1 ? "draft" : "drafts"} · only you can
              see these
            </SectionRule>
            <ul>
              {visibleDrafts.map(({ original: draft }) => (
                <DraftListRow draft={draft} key={draft.id} />
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function PublishedRow({ ident, row }: { ident: string; row: ManagerRow }) {
  const date = formatDate(row.publishedAt ?? undefined);
  const readingLabel = formatReadingTime(row.readingMinutes);
  const href = `/@${encodeURIComponent(ident)}/${encodeURIComponent(row.rkey)}`;
  return (
    <li className="flex items-start gap-4 border-rule border-b py-5">
      <PostThumb coverPath={row.coverPath} title={row.title} />
      <div className="min-w-0 flex-1">
        <a
          className="font-semibold text-ink text-lg leading-snug hover:underline hover:underline-offset-4"
          href={href}
        >
          {row.title}
        </a>
        {row.description && (
          <p className="mt-1 line-clamp-1 text-ink-soft text-sm leading-relaxed">
            {row.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-display text-ink-soft text-xs">
          <span>
            {date && (
              <time dateTime={row.publishedAt ?? undefined}>{date}</time>
            )}
            {date && readingLabel && " · "}
            {readingLabel}
            {row.updatedAt
              ? date || readingLabel
                ? " · edited"
                : "Edited"
              : null}
            {!row.editable && (
              <span>
                {date || readingLabel ? " · " : ""}Written in another app
              </span>
            )}
          </span>
          <PostMetrics engagement={row.engagement} views={row.views} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4">
          {row.editable && (
            <a
              className={INLINE_ACTION}
              href={`/write?edit=${encodeURIComponent(row.rkey)}`}
            >
              Edit
            </a>
          )}
          {row.announced ? (
            <>
              <ExternalLink
                className={INLINE_ACTION}
                href={bskyPostUrl(row.announced.did, row.announced.postRkey)}
                title="View the announcement post on Bluesky"
              >
                Announced ↗
              </ExternalLink>
              <AnnounceButton
                confirmMessage="Already announced — post again?"
                label="Announce again"
                rkey={row.rkey}
              />
            </>
          ) : (
            <AnnounceButton label="Announce" rkey={row.rkey} />
          )}
          <DeletePostForm
            announced={row.announced}
            rkey={row.rkey}
            title={row.title}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * One scheduled post — and the whole point of this tab: A WRITER MUST NEVER HAVE
 * TO WONDER WHETHER SOMETHING WENT OUT.
 *
 * A pending row states its time in the writer's own zone. A failed row states
 * the cron's own reason VERBATIM (it was written for them to read — see
 * ~/lib/scheduled-publish) and carries the two ways out: publish it now, or
 * cancel and keep the draft. Both are plain form posts to /api/publish, like
 * every other action on this page.
 *
 * Exported for tests (dashboard-scheduled.test.tsx) — not a route.
 */
export function ScheduledListRow({ row }: { row: ScheduledPostRow }) {
  const failed = row.status === "failed";
  const editHref = `/write?draft=${encodeURIComponent(row.draftId)}`;
  return (
    <li className="border-rule border-b py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <a
          className="font-semibold text-ink leading-snug hover:underline hover:underline-offset-4"
          href={editHref}
        >
          {row.title}
        </a>
        <span className="font-display text-ink-soft text-sm">
          {failed ? "Didn't go out \u00b7 was due " : "Scheduled for "}
          <ScheduledTime iso={row.dueAt} />
        </span>
      </div>
      {failed && (
        <Notice tone="alert">
          {/* The cron's own words, unedited: paraphrasing them here would be a
              second copy of the same message, free to drift from the stored
              one. */}
          {row.lastError ??
            "This post didn't go out, and Goldroad didn't record why. Publishing it now is the fastest way through."}
        </Notice>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4">
        <a className={INLINE_ACTION} href={editHref}>
          Edit
        </a>
        <form
          action="/api/publish"
          className="inline"
          method="post"
          onSubmit={(event) => {
            // A failed post needs no confirmation — publishing is the fix. One
            // that is merely waiting does: pressing this gives up its slot.
            if (
              !failed &&
              !window.confirm(
                `Publish "${row.title}" now instead of waiting for its scheduled time?`,
              )
            )
              event.preventDefault();
          }}
        >
          <input name="intent" type="hidden" value="publish-now" />
          <input name="draftId" type="hidden" value={row.draftId} />
          <button className={cn(INLINE_ACTION, "cursor-pointer")} type="submit">
            Publish now
          </button>
        </form>
        <form
          action="/api/publish"
          className="inline"
          method="post"
          onSubmit={(event) => {
            if (
              !window.confirm(
                `Cancel the schedule for "${row.title}"? It stays in your drafts.`,
              )
            )
              event.preventDefault();
          }}
        >
          <input name="intent" type="hidden" value="unschedule" />
          <input name="id" type="hidden" value={row.id} />
          <button className={DESTRUCTIVE_ACTION} type="submit">
            Cancel
          </button>
        </form>
        {/* Said plainly rather than hidden: a post on its third try is a post
            in trouble, and the writer is the one who can act on that. */}
        {row.attempts > 1 && (
          <span className="font-display text-ink-soft text-xs">
            {row.attempts} attempts
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * One draft row. Delete is a fetch (the drafts API is JSON, unlike the
 * form-posting publish intents) followed by a router invalidate to refresh
 * the loader data; confirm-before-delete and destructive hover match the
 * published rows.
 */
function DraftListRow({ draft }: { draft: DraftRow }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const name = draft.title.trim() || "(untitled draft)";
  const date = formatDate(draft.updatedAt);
  const resumeHref = `/write?draft=${encodeURIComponent(draft.id)}`;

  async function deleteDraft() {
    if (!window.confirm(`Delete the draft "${name}"? This can't be undone.`))
      return;
    setFailed(false);
    try {
      const res = await fetch(
        `/api/drafts?id=${encodeURIComponent(draft.id)}`,
        {
          method: "DELETE",
        },
      );
      // 404 = already gone (another tab) — refreshing the list is the fix.
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      await router.invalidate();
    } catch {
      setFailed(true);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-rule border-b py-4">
      <span>
        <a
          className="font-semibold text-ink leading-snug hover:underline hover:underline-offset-4"
          href={resumeHref}
        >
          {name}
        </a>
        {date && (
          <span className="ml-3 font-display text-ink-soft text-sm">
            Edited <time dateTime={draft.updatedAt}>{date}</time>
          </span>
        )}
        {failed && (
          <Notice tone="alert">
            That draft couldn't be deleted right now. Try again.
          </Notice>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-x-4">
        <a className={INLINE_ACTION} href={resumeHref}>
          Resume
        </a>
        <button
          className={DESTRUCTIVE_ACTION}
          onClick={() => void deleteDraft()}
          type="button"
        >
          Delete
        </button>
      </span>
    </li>
  );
}

/** Nothing published and nothing drafted — teach the next step rather than
 * showing an empty list with controls above it. */
function FirstRun() {
  return (
    <div className="mt-8 border-2 border-ink p-8">
      <h2 className="font-black font-display text-ink text-xl tracking-tight">
        No posts yet.
      </h2>
      <p className="mt-3 text-ink-soft leading-relaxed">
        Your first post publishes straight to your own data repo and goes live
        on your public page. Announce it and it reaches your Bluesky followers
        as a rich card linking back here.
      </p>
      <a
        className="mt-6 inline-flex min-h-11 items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
        href="/write"
      >
        Write your first post
      </a>
      <p className="mt-4 font-display text-ink-soft text-sm">
        Coming from Substack or another platform?{" "}
        <a
          className="underline underline-offset-2 transition-colors hover:text-ink"
          href="/import"
        >
          Import your writing
        </a>{" "}
        — posts arrive as private drafts, and nothing changes at the source.
      </p>
    </div>
  );
}

/**
 * The one-shot outcome of a write. A server redirect appends exactly one of
 * these to /dashboard (`?published=<rkey>`, `?announced=<rkey>`,
 * `?scheduled=1`) and they are read once: into the confirmation notice, and
 * into a single analytics event.
 */
export type DashboardOutcome = {
  published?: string;
  announced?: string;
  scheduled?: boolean;
};

/** Drops the outcome params and nothing else — `tab`, `cursor`, `error` and
 * the rest are durable URL state a writer can reload into. */
export function withoutOutcomeParams<T extends object>(
  search: T,
): Omit<T, keyof DashboardOutcome> {
  const { published, announced, scheduled, ...rest } = search as T &
    DashboardOutcome;
  return rest;
}

/**
 * Consume the outcome params: fire the matching analytics event at most once
 * per redirect, and hand back what the notices need so they keep rendering
 * after the params leave the URL.
 *
 * They have to leave. The redirect target is an ordinary reloadable address,
 * so a refresh, a back-nav or any remount replays whatever the query string
 * still says — and analytics here is cookieless with memory persistence, so
 * nothing downstream collapses the repeats. Left in place, `post_published`
 * counts reloads instead of posts.
 *
 * Two guards, covering different things: `strip` rewrites the URL so a fresh
 * page load has nothing left to replay, and the ref pins the event to the
 * params that produced it so a re-render before that rewrite lands (React's
 * double-invoked effects in development, a changing `navigate` identity)
 * cannot fire it a second time.
 *
 * Exported for tests (dashboard-outcome-params.test.tsx) — not a route.
 */
export function useOutcomeParams(
  search: DashboardOutcome,
  ident: string,
  strip: () => void,
): DashboardOutcome {
  const { published, announced, scheduled } = search;
  // Seeded from the URL so the notice is on screen in the first paint, not one
  // frame after it.
  const [outcome, setOutcome] = useState<DashboardOutcome>(() => ({
    published,
    announced,
    scheduled,
  }));
  const consumed = useRef<string | null>(null);

  useEffect(() => {
    if (!(published || announced || scheduled)) return;
    const key = `${published ?? ""}|${announced ?? ""}|${scheduled ? "1" : ""}`;
    if (consumed.current === key) return;
    consumed.current = key;

    // Analytics (cookieless, no-op without a PostHog key): this is the closest
    // client-side moment to the actual PDS write. Properties stay within
    // DID/handle policy.
    if (published) capture("post_published", { rkey: published, ident });
    if (announced) capture("post_announced", { rkey: announced, ident });
    // Scheduling adoption. No rkey to attach — a scheduled post has not been
    // published yet, so there is no record to name.
    if (scheduled) capture("post_scheduled", { ident });

    setOutcome({ published, announced, scheduled });
    strip();
  }, [published, announced, scheduled, ident, strip]);

  return outcome;
}

function DashboardPage() {
  const {
    ident,
    handle,
    rows,
    engagement,
    nextCursor,
    onLegacyUrl,
    drafts,
    scheduled,
  } = Route.useLoaderData();
  const search = Route.useSearch();
  const { error, deleted, moved, cursor } = search;
  const navigate = Route.useNavigate();
  const message = errorMessage(error);
  const tab: PostsTab = search.tab ?? "published";

  // `replace`, so Back still goes where the writer came from rather than to
  // the pre-strip URL — which would put the consumed params right back.
  const stripOutcomeParams = useCallback(() => {
    void navigate({ replace: true, search: withoutOutcomeParams });
  }, [navigate]);
  const outcome = useOutcomeParams(search, ident, stripOutcomeParams);

  return (
    <AppShell header={{ variant: "signed-in", ident, active: "posts" }}>
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        {/* No page-level "New post" button here any more: the rail carries the
            writer's primary action on every surface, and a second copy of it
            would spend the view's one accent twice. Import moved down into the
            manager's toolbar, where a task done to your archive belongs. */}
        <div>
          <h1 className="font-black font-display text-3xl text-ink tracking-tight">
            Your posts
          </h1>
          <p className="mt-2 text-ink-soft">
            Everything published from your own data repo — including posts
            written in other apps.
          </p>
        </div>

        {outcome.published && (
          <Notice tone="info">
            Published.{" "}
            {/* New tab: the writer keeps their dashboard context. */}
            <ExternalLink
              className="underline underline-offset-2"
              href={`/@${encodeURIComponent(ident)}/${outcome.published}`}
            >
              View it live
            </ExternalLink>
            <span className="mt-1 block">
              {ANNOUNCE_EXPLAINER} <AnnounceButton rkey={outcome.published} />
            </span>
          </Notice>
        )}
        {outcome.announced && (
          <Notice tone="info">
            Announced — your followers will see this post as a card that links
            back here.{" "}
            <ExternalLink
              className="underline underline-offset-2"
              href={bskyPostUrl(ident, outcome.announced)}
            >
              View your post on Bluesky
            </ExternalLink>
          </Notice>
        )}
        {outcome.scheduled && (
          <Notice tone="info">
            Scheduled. It's in the queue below with its time — you can change
            it, cancel it, or publish it now from there.
          </Notice>
        )}
        {search.unscheduled && (
          <Notice tone="info">
            Schedule cancelled — the post is back to being a draft, and nothing
            will publish on its own.
          </Notice>
        )}
        {deleted && <Notice tone="info">Deleted from your repo.</Notice>}
        {moved && (
          <Notice tone="info">
            Done — your publication now lives at trygoldroad.com. Old links
            redirect here.
          </Notice>
        )}
        {onLegacyUrl && !moved && (
          <MovePublicationNotice returnTo="dashboard" />
        )}
        {message && (
          <Notice tone="alert">
            {message}
            {needsReconnect(error) && handle && (
              <form action="/login" className="mt-2" method="post">
                <input name="handle" type="hidden" value={handle} />
                <input name="returnTo" type="hidden" value="/dashboard" />
                <button
                  className="cursor-pointer font-bold underline underline-offset-2"
                  type="submit"
                >
                  Re-connect your account
                </button>{" "}
                — you'll approve the new permission on your own server.
              </form>
            )}
          </Notice>
        )}

        <PostsManager
          cursor={cursor}
          drafts={drafts}
          engagement={new Map(engagement)}
          ident={ident}
          nextCursor={nextCursor}
          onTabChange={(next) =>
            // The tab is an address, but switching it must not re-run the
            // loader or push a history entry for every glance.
            void navigate({
              replace: true,
              search: (prev) => ({ ...prev, tab: next }),
            })
          }
          rows={rows}
          scheduled={scheduled}
          tab={tab}
        />
      </main>
    </AppShell>
  );
}
