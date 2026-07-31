/**
 * The overview — where a signed-in writer lands, and the only surface whose
 * job is "how are things, and what's next?".
 *
 * Deliberately not a greeting and not a dashboard of everything: an identity
 * line, the numbers the writer has actually earned, the piece they published
 * last, the pieces they haven't finished, and ONE next action that adapts to
 * whether there's unfinished work. Depth lives on the surfaces built for it —
 * the posts manager for triage, the reading pages for readers.
 *
 * Absence discipline: every block on this page can be missing, and a missing
 * block renders as nothing rather than as a zero or a teaser. The headline
 * numbers appear only while the analytics seam is answering; a flaked PDS read
 * says so instead of reporting an empty publication.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";

import { formatDate } from "~/components/document-article";
import { ExternalLink } from "~/components/external-link";
import { Notice } from "~/components/notice";
import { PostMetrics, PostThumb } from "~/components/post-summary";
import { AppShell } from "~/components/site-chrome";
import {
  listRecords,
  listRecordsPage,
  MAX_LIST_RECORDS,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import {
  type DashboardRow,
  type DraftRow,
  mapDashboardRows,
  viewsByRkey,
} from "~/lib/dashboard";
import { listDrafts } from "~/lib/drafts";
import {
  type DocumentEngagement,
  getDocumentEngagement,
} from "~/lib/engagement";
import { readLiveSessionDid } from "~/lib/live-session";
import { formatReadingTime } from "~/lib/reading-time";
import { type StatsState, useWriterStats } from "~/lib/use-writer-stats";
import { env } from "cloudflare:workers";

/** How many unfinished pieces the overview lists before handing off to the
 * manager. Three is a shortlist; more is a list, and lists have a home. */
const DRAFT_SHORTLIST = 3;

/** What the overview knows about the writer's published work. `null` for the
 * whole object = the PDS read flaked, which is a different statement from
 * "nothing published" and gets different words. */
type PublishedSummary = {
  count: number;
  /** False when the first page filled up: there are more records than we
   * counted, so the count is a floor and is labelled as one. */
  countComplete: boolean;
  latest: DashboardRow | null;
};

const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const did = await readLiveSessionDid(
    request,
    env.COOKIE_SECRET,
    drizzle(env.DB),
  );
  if (!did) return null;
  const handle = await resolveDidToHandle(did).catch(() => null);
  const pds = await resolveDidToPds(did).catch(() => null);

  const [draftRows, docsPage, pubs] = await Promise.all([
    listDrafts(drizzle(env.DB), did).catch(() => null),
    pds
      ? listRecordsPage<StandardDocument>(pds, did, "site.standard.document", {
          cursor: undefined,
        }).catch(() => null)
      : null,
    pds
      ? listRecords<StandardPublication>(
          pds,
          did,
          "site.standard.publication",
          {
            limit: 10,
            reverse: true,
          },
        ).catch(() => [])
      : [],
  ]);

  const rows = docsPage ? mapDashboardRows(docsPage.records, did) : null;
  const latest = rows?.[0] ?? null;
  // The most recent post's cross-network counts, shared with the cache the
  // reading surfaces warm. Null whenever there's nothing honest to show.
  const latestRecord = latest
    ? docsPage?.records.find((r) => r.uri.endsWith(`/${latest.rkey}`))
    : undefined;
  const engagement = latestRecord
    ? await getDocumentEngagement(latestRecord.value.bskyPostRef).catch(
        () => null,
      )
    : null;

  // Oldest publication = the writer's original one, the same one the public
  // archive shows as their masthead.
  const publication = pubs[0]?.value ?? null;
  const iconCid = coverImageCid(publication?.icon);

  return {
    ident: handle ?? did,
    publicationName:
      typeof publication?.name === "string" && publication.name.trim() !== ""
        ? publication.name
        : null,
    iconPath: iconCid ? blobImagePath(did, iconCid) : null,
    published: rows
      ? ({
          count: rows.length,
          countComplete: docsPage
            ? docsPage.records.length < MAX_LIST_RECORDS
            : false,
          latest,
        } satisfies PublishedSummary)
      : null,
    engagement,
    // ISO strings, not Dates: loader data must serialize identically on both
    // sides. null = the read flaked (not "no drafts").
    drafts:
      draftRows?.map((d) => ({
        id: d.id,
        title: d.title,
        updatedAt: d.updatedAt.toISOString(),
        description: null,
      })) ?? null,
  };
});

/**
 * The landing contract for this surface: the overview is the signed-in home,
 * so arriving without a session is not an error page — it's a redirect to the
 * sign-in form at /write, exactly like the posts manager does.
 *
 * The bounce names this page as the destination, so signing in comes back here
 * rather than stranding the writer in the editor that happens to host the form.
 * Exported so the contract is testable without a live session.
 */
export function requireOverview<T>(overview: T | null): T {
  if (!overview)
    throw redirect({ to: "/write", search: { returnTo: "/home" } });
  return overview;
}

export const Route = createFileRoute("/home")({
  loader: async () => requireOverview(await getOverview()),
  head: () => ({
    meta: [
      { title: "Home — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HomePage,
});

/** Untitled drafts still need something to click. */
function draftName(draft: DraftRow): string {
  return draft.title.trim() || "(untitled draft)";
}

/**
 * The writer's publication identity, as the page's own heading: this is their
 * publication, so its name is the largest thing on the surface. Before the
 * first publish there's no publication record yet, and the handle stands in.
 */
function IdentityLine({
  ident,
  publicationName,
  iconPath,
}: {
  ident: string;
  publicationName: string | null;
  iconPath: string | null;
}) {
  return (
    <header className="flex items-start gap-4">
      {iconPath && (
        <img
          alt=""
          className="size-12 shrink-0 border border-rule object-cover sm:size-14"
          src={iconPath}
        />
      )}
      <div className="min-w-0">
        <h1 className="text-balance font-black font-display text-2xl text-ink tracking-tight sm:text-3xl">
          {publicationName ?? `@${ident}`}
        </h1>
        <p className="mt-1 font-display text-ink-soft text-sm">
          {publicationName && <span className="mr-1">@{ident}</span>}
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href={`/@${encodeURIComponent(ident)}`}
          >
            View your publication
          </a>
        </p>
      </div>
    </header>
  );
}

/** One headline number. Ink only — the page's single accent belongs to its
 * primary action. */
function HeadlineNumber({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-black font-display text-2xl text-ink tabular-nums tracking-tight sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]">
        {label}
      </p>
    </div>
  );
}

/**
 * The headline numbers, gated end to end on the analytics seam.
 *
 * When the seam isn't configured for this deployment the whole block is
 * absent — not a teaser, not a row of dashes, not a "coming soon" card. There
 * is no skeleton state either, and that's deliberate: until the fetch
 * resolves we don't know whether this block will exist at all, so a skeleton
 * would be a promise we might immediately break.
 */
function HeadlineNumbers({
  published,
  drafts,
  ident,
  stats,
}: {
  published: PublishedSummary | null;
  drafts: DraftRow[] | null;
  ident: string;
  stats: StatsState;
}) {
  if (stats.status !== "ready") return null;

  const postCount = published
    ? `${published.count.toLocaleString()}${published.countComplete ? "" : "+"}`
    : null;
  return (
    <section
      aria-label="Your numbers"
      className="mt-8 border-ink border-t-2 pt-5"
    >
      <div className="flex flex-wrap gap-x-8 gap-y-5">
        <HeadlineNumber
          label="All-time views"
          value={stats.total.toLocaleString()}
        />
        {postCount !== null && (
          <HeadlineNumber label="Posts published" value={postCount} />
        )}
        {drafts !== null && (
          <HeadlineNumber
            label="Drafts in progress"
            value={drafts.length.toLocaleString()}
          />
        )}
      </div>
      <p className="mt-3 font-display text-ink-soft text-xs">
        View counts are approximate — privacy-respecting analytics miss some
        readers.
        {published && !published.countComplete && (
          <>
            {" "}
            Your post count covers the most recent {MAX_LIST_RECORDS};{" "}
            <a
              className="underline underline-offset-2 transition-colors hover:text-ink"
              href={`/@${encodeURIComponent(ident)}`}
            >
              your publication
            </a>{" "}
            has the full archive.
          </>
        )}
      </p>
    </section>
  );
}

/**
 * The adaptive next action: resume the piece in progress, or start one.
 *
 * Ink, not spot — deliberately. The rail's "New post" now carries the one
 * vermillion moment on every writer surface (see `RailPrimaryAction` in
 * `~/components/site-chrome`), so this button takes the ink vocabulary rather
 * than competing with it two inches away. It is still the page's own primary
 * button; it just isn't the page's accent.
 */
function NextAction({ drafts }: { drafts: DraftRow[] | null }) {
  const resume = drafts?.[0] ?? null;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
      {resume ? (
        <a
          className="inline-flex min-h-11 max-w-full items-center bg-ink px-5 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
          href={`/write?draft=${encodeURIComponent(resume.id)}`}
        >
          <span className="truncate">Resume "{draftName(resume)}"</span>
        </a>
      ) : (
        <a
          className="inline-flex min-h-11 items-center bg-ink px-5 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
          href="/write"
        >
          Start writing
        </a>
      )}
      {resume && (
        <a
          className="inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
          href="/write"
        >
          Start something new
        </a>
      )}
      <a
        className="inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
        href="/import"
      >
        Import your writing
      </a>
    </div>
  );
}

/** The piece the writer published last, with whatever it has actually
 * collected. Absent metrics render as nothing at all. */
function LatestPost({
  ident,
  row,
  views,
  engagement,
}: {
  ident: string;
  row: DashboardRow;
  views?: number;
  engagement: DocumentEngagement | null;
}) {
  const date = formatDate(row.publishedAt ?? undefined);
  const readingLabel = formatReadingTime(row.readingMinutes);
  const href = `/@${encodeURIComponent(ident)}/${encodeURIComponent(row.rkey)}`;
  return (
    <section aria-labelledby="latest-heading" className="mt-10">
      <p
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="latest-heading"
      >
        Published most recently
      </p>
      <div className="flex items-start gap-4 py-5">
        <PostThumb coverPath={row.coverPath} title={row.title} />
        <div className="min-w-0 flex-1">
          <a
            className="font-semibold text-ink text-lg leading-snug hover:underline hover:underline-offset-4"
            href={href}
          >
            {row.title}
          </a>
          {row.description && (
            <p className="mt-1 line-clamp-2 text-ink-soft text-sm leading-relaxed">
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
            </span>
            <PostMetrics engagement={engagement} views={views} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4">
            {row.editable && (
              <a
                className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                href={`/write?edit=${encodeURIComponent(row.rkey)}`}
              >
                Edit
              </a>
            )}
            <ExternalLink
              className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href={href}
            >
              View it live
            </ExternalLink>
            <a
              className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href="/dashboard"
            >
              All posts →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Unfinished work, shortlisted. The overflow link hands off to the manager
 * rather than growing this list. */
function DraftShortlist({ drafts }: { drafts: DraftRow[] }) {
  const shown = drafts.slice(0, DRAFT_SHORTLIST);
  return (
    <section aria-labelledby="drafts-heading" className="mt-10">
      <p
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="drafts-heading"
      >
        In progress · only you can see these
      </p>
      <ul>
        {shown.map((draft) => {
          const date = formatDate(draft.updatedAt);
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-rule border-b py-4"
              key={draft.id}
            >
              <span className="min-w-0">
                <a
                  className="font-semibold text-ink leading-snug hover:underline hover:underline-offset-4"
                  href={`/write?draft=${encodeURIComponent(draft.id)}`}
                >
                  {draftName(draft)}
                </a>
                {date && (
                  <span className="ml-3 font-display text-ink-soft text-sm">
                    Edited <time dateTime={draft.updatedAt}>{date}</time>
                  </span>
                )}
              </span>
              <a
                className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                href={`/write?draft=${encodeURIComponent(draft.id)}`}
              >
                Resume
              </a>
            </li>
          );
        })}
      </ul>
      {drafts.length > shown.length && (
        <p className="mt-4">
          <a
            className="font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
            href="/dashboard?tab=drafts"
          >
            All {drafts.length} drafts →
          </a>
        </p>
      )}
    </section>
  );
}

/** Signed in, nothing written yet. Teaches the first step; the primary action
 * above is already the one to take. */
function FirstRun() {
  return (
    <div className="mt-10 border-2 border-ink p-8">
      <h2 className="font-black font-display text-ink text-xl tracking-tight">
        Your publication starts with one post.
      </h2>
      <p className="mt-3 text-ink-soft leading-relaxed">
        Whatever you publish goes straight into your own data repo and appears
        on your public page. Announce it and your Bluesky followers see it as a
        card linking back to you — no cold start, no list to build first.
      </p>
      <p className="mt-4 font-display text-ink-soft text-sm">
        Already writing somewhere else?{" "}
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

/** The stats seam's per-post views for one post, or undefined when the seam
 * isn't answering or never recorded that path. Shares the exact absence rule
 * the manager's rows use — absence is never rendered as zero. */
function latestViewsOf(
  ident: string,
  latest: DashboardRow | null,
  stats: StatsState,
): number | undefined {
  if (stats.status !== "ready" || !latest) return undefined;
  return viewsByRkey([latest], stats.paths, ident).get(latest.rkey);
}

/**
 * The overview itself, separated from the route so it can be rendered — and
 * tested — without a router or a live session.
 */
export function Overview({
  ident,
  publicationName,
  iconPath,
  published,
  engagement,
  drafts,
}: {
  ident: string;
  publicationName: string | null;
  iconPath: string | null;
  /** null = the PDS read flaked, which is not the same claim as "nothing
   * published" and gets different words. */
  published: PublishedSummary | null;
  engagement: DocumentEngagement | null;
  /** null = the drafts read flaked. */
  drafts: DraftRow[] | null;
}) {
  // One read of the analytics seam for the whole page: two hooks would mean
  // two fetches of the same endpoint on every visit.
  const stats = useWriterStats();
  const latest = published?.latest ?? null;
  const latestViews = latestViewsOf(ident, latest, stats);
  const nothingYet =
    published !== null &&
    published.count === 0 &&
    drafts !== null &&
    drafts.length === 0;

  return (
    <>
      <IdentityLine
        iconPath={iconPath}
        ident={ident}
        publicationName={publicationName}
      />
      <NextAction drafts={drafts} />
      <HeadlineNumbers
        drafts={drafts}
        ident={ident}
        published={published}
        stats={stats}
      />

      {published === null && (
        <Notice tone="alert">
          Your published posts couldn't be loaded right now — your data server
          may be briefly unreachable. They're safe in your repo; refresh to try
          again.
        </Notice>
      )}
      {drafts === null && (
        <Notice tone="alert">
          Your drafts couldn't be loaded right now — they're safe; refresh to
          try again.
        </Notice>
      )}

      {nothingYet && <FirstRun />}
      {latest && (
        <LatestPost
          engagement={engagement}
          ident={ident}
          row={latest}
          views={latestViews}
        />
      )}
      {drafts !== null && drafts.length > 0 && (
        <DraftShortlist drafts={drafts} />
      )}
    </>
  );
}

function HomePage() {
  const data = Route.useLoaderData();
  return (
    <AppShell
      header={{ variant: "signed-in", ident: data.ident, active: "home" }}
    >
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <Overview {...data} />
      </main>
    </AppShell>
  );
}
