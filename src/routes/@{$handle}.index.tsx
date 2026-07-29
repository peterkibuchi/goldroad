import { createFileRoute, notFound } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import {
  ContentUnavailable,
  formatDate,
  isHiddenNotFound,
  ReportLink,
} from "~/components/document-article";
import { SearchIcon } from "~/components/icons";
import { filterPostsByQuery, groupPostsByMonth, monogram } from "~/lib/archive";
import {
  isDid,
  isHandle,
  isValidCursor,
  listRecords,
  listRecordsPage,
  NotFoundError,
  resolveDidToPds,
  resolveHandleToDid,
  rkeyFromUri,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import { checkHidden } from "~/lib/moderation";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { formatReadingTime, listItemReadingMinutes } from "~/lib/reading-time";
import { cn } from "~/lib/utils";

/**
 * Public publication page — calm register. Everything
 * is read from the writer's own PDS over public XRPC: the publication record
 * (name/description/icon) and one 50-document page of site.standard.document
 * records ("Older posts" continues via the PDS cursor in ?cursor=). Works
 * for any atproto author, not just Goldroad writers.
 */
export const Route = createFileRoute("/@{$handle}/")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: { cursor?: string } = {};
    if (isValidCursor(search.cursor)) out.cursor = search.cursor;
    return out;
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ params, deps }) => {
    const ident = decodeURIComponent(params.handle);
    if (!isHandle(ident) && !isDid(ident)) throw notFound();
    try {
      const did = isDid(ident) ? ident : await resolveHandleToDid(ident);
      // Author-level takedown (moderation kit, audit #1): a hidden DID stops
      // serving its whole publication with a calm 404 + takedown notice.
      if (await checkHidden({ data: { did } })) {
        throw notFound({ data: { hidden: true } });
      }
      const pds = await resolveDidToPds(did);
      const [pubs, docsPage] = await Promise.all([
        // Oldest publication = the author's original one; display-only here.
        listRecords<StandardPublication>(
          pds,
          did,
          "site.standard.publication",
          {
            limit: 10,
            reverse: true,
          },
        ).catch(() => []),
        listRecordsPage<StandardDocument>(pds, did, "site.standard.document", {
          cursor: deps.cursor,
        }).catch(() => ({ records: [], cursor: null })),
      ]);
      const docs = docsPage.records;
      const publication = pubs[0]?.value ?? null;
      // The record's AT-URI backs the standard.site publication link tag.
      const publicationAtUri = pubs[0]?.uri ?? null;
      // Publication identity image (gap #8, substack-patterns dossier: the
      // lexicon field already existed, nothing ever rendered it). Served
      // through the same /img proxy as document covers.
      const iconCid = coverImageCid(publication?.icon);
      const posts = docs
        .flatMap((r) => {
          const rkey = rkeyFromUri(r.uri);
          if (!rkey || typeof r.value.title !== "string") return [];
          const coverCid = coverImageCid(r.value.coverImage);
          const textContent =
            typeof r.value.textContent === "string" ? r.value.textContent : "";
          return [
            {
              rkey,
              title: r.value.title,
              description:
                typeof r.value.description === "string"
                  ? r.value.description
                  : null,
              publishedAt:
                typeof r.value.publishedAt === "string"
                  ? r.value.publishedAt
                  : null,
              // Validated cover, served through the /img proxy (never the
              // PDS hostname). Same-origin path — safe to render directly.
              coverPath: coverCid ? blobImagePath(did, coverCid) : null,
              // Bounded scan (see ~/lib/reading-time): this loop can see up
              // to 50 third-party records per page.
              readingMinutes: listItemReadingMinutes(textContent),
            },
          ];
        })
        .sort(
          (a, b) =>
            Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") ||
            (a.rkey < b.rkey ? 1 : -1),
        );
      return {
        ident,
        publication,
        publicationAtUri,
        iconPath: iconCid ? blobImagePath(did, iconCid) : null,
        posts,
        nextCursor: docsPage.cursor,
      };
    } catch (err) {
      if (err instanceof NotFoundError) throw notFound();
      throw err;
    }
  },
  // Interop + SEO head. Publication home pages reference their backing record
  // via rel="site.standard.publication" (standard.site convention — see the
  // matching document-page tags in ~/components/document-article). Canonical
  // is the record's own url field: for Goldroad writers that is this page; for
  // third-party authors it honestly points at their home (e.g. *.leaflet.pub).
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Not found" }] };
    const { ident, publication, publicationAtUri } = loaderData;
    const title = publication?.name ?? ident;
    const canonicalUrl = publication?.url?.startsWith("https://")
      ? publication.url
      : null;
    return {
      meta: [
        { title },
        ...(publication?.description
          ? [
              { name: "description", content: publication.description },
              { property: "og:description", content: publication.description },
            ]
          : []),
        { property: "og:title", content: title },
        { property: "og:type", content: "website" },
        ...(canonicalUrl
          ? [{ property: "og:url", content: canonicalUrl }]
          : []),
      ],
      links: [
        ...(canonicalUrl ? [{ rel: "canonical", href: canonicalUrl }] : []),
        ...(publicationAtUri
          ? [
              { rel: "alternate", href: publicationAtUri },
              { rel: "site.standard.publication", href: publicationAtUri },
            ]
          : []),
        // Feed discovery — absolute, minted from the canonical origin so the
        // advertised feed URL never depends on the serving hostname.
        {
          rel: "alternate",
          type: "application/rss+xml",
          title: `${title} — RSS`,
          href: `${CANONICAL_ORIGIN}/@${encodeURIComponent(ident)}/rss.xml`,
        },
      ],
    };
  },
  component: PublicationPage,
  notFoundComponent: PublicationNotFound,
});

/** One archive row's view model — matches the loader's `posts` mapping
 * above. Kept as an explicit type (rather than derived from the loader's
 * return type) so PostRow/PostThumb stay easy to unit-test in isolation. */
type ArchivePost = {
  rkey: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  coverPath: string | null;
  readingMinutes: number;
};

/** Fixed-size thumbnail slot for an archive row — a cover if the post has
 * one, else the publication's own icon, else a quiet monogram. Always
 * renders the same h-20 w-20 box so cover-less rows never leave an
 * inconsistent gap in the list's rhythm (substack-patterns dossier §1). */
function PostThumb({
  coverPath,
  iconPath,
  title,
}: {
  coverPath: string | null;
  iconPath: string | null;
  title: string;
}) {
  if (coverPath || iconPath) {
    return (
      <img
        alt=""
        className="mt-1 h-20 w-20 shrink-0 object-cover"
        loading="lazy"
        src={(coverPath ?? iconPath) as string}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className="mt-1 flex h-20 w-20 shrink-0 items-center justify-center bg-ink/5 font-display text-2xl text-ink-soft/40"
    >
      {monogram(title)}
    </div>
  );
}

function PostRow({
  ident,
  post,
  iconPath,
}: {
  ident: string;
  post: ArchivePost;
  iconPath: string | null;
}) {
  const date = formatDate(post.publishedAt ?? undefined);
  const readingLabel = formatReadingTime(post.readingMinutes);
  return (
    <li className="border-rule border-b" key={post.rkey}>
      <a
        className="group flex items-start gap-6 py-8"
        href={`/@${encodeURIComponent(ident)}/${encodeURIComponent(post.rkey)}`}
      >
        <span className="min-w-0 flex-1">
          <h2 className="text-balance font-semibold text-2xl text-ink leading-snug group-hover:underline group-hover:underline-offset-4">
            {post.title}
          </h2>
          {post.description ? (
            <p className="mt-2.5 line-clamp-2 text-base text-ink-soft leading-relaxed">
              {post.description}
            </p>
          ) : null}
          {(date || readingLabel) && (
            // Quiet caps: secondary to the title at a glance.
            <p className="mt-3 font-display text-ink-soft text-xs uppercase tracking-wide">
              {date && (
                <time dateTime={post.publishedAt ?? undefined}>{date}</time>
              )}
              {date && readingLabel && " · "}
              {readingLabel}
            </p>
          )}
        </span>
        <PostThumb
          coverPath={post.coverPath}
          iconPath={iconPath}
          title={post.title}
        />
      </a>
    </li>
  );
}

function PublicationPage() {
  const { ident, publication, posts, nextCursor, iconPath } =
    Route.useLoaderData();
  const [query, setQuery] = useState("");
  const filtered = filterPostsByQuery(posts, query);
  const isSearching = query.trim() !== "";
  const groups = isSearching
    ? [{ label: null as string | null, posts: filtered }]
    : groupPostsByMonth(filtered);

  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-16 md:py-24">
        {/* The masthead: the writer's name is the largest text on the page —
            this is their publication, not a Goldroad page. */}
        <header className="mb-14 border-ink border-b pb-10">
          <div className="flex items-start gap-6">
            {iconPath && (
              <img
                alt=""
                className="h-20 w-20 shrink-0 border border-rule object-cover sm:h-24 sm:w-24"
                src={iconPath}
              />
            )}
            <div className="min-w-0">
              <h1 className="text-balance font-semibold text-5xl text-ink leading-[1.05] md:text-6xl">
                {publication?.name ?? ident}
              </h1>
              <p className="mt-4 font-display text-ink-soft text-sm tracking-wide">
                @{ident}
              </p>
              {publication?.description ? (
                <p className="mt-6 max-w-[52ch] text-ink-soft text-lg italic leading-relaxed">
                  {publication.description}
                </p>
              ) : null}
            </div>
          </div>
        </header>
        {posts.length > 0 && (
          // Sort/search row: "Latest" is the only real sort today (no view
          // or reply-count signal yet to back Top/Discussions) — the row is
          // laid out so those can join later, but a tab that doesn't work
          // yet is never rendered (substack-patterns dossier §1).
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-rule border-b pb-3">
            <nav aria-label="Sort posts">
              <span className="font-display font-semibold text-ink text-sm uppercase tracking-wide">
                Latest
              </span>
            </nav>
            <label className="flex items-center gap-2 text-ink-soft">
              <SearchIcon className="h-4 w-4 shrink-0" />
              <span className="sr-only">Search posts</span>
              <input
                className="w-28 bg-transparent font-display text-ink text-sm placeholder:text-ink-soft/60 focus:w-48 focus:outline-none"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search posts"
                style={{ transition: "width 150ms ease" }}
                type="search"
                value={query}
              />
            </label>
          </div>
        )}
        {posts.length > 0 ? (
          isSearching && filtered.length === 0 ? (
            <p className="mt-8 text-ink-soft text-lg italic leading-relaxed">
              No posts match "{query}".
            </p>
          ) : (
            groups.map((group, gi) => (
              <Fragment key={group.label ?? `flat-${gi}`}>
                {group.label && (
                  <p
                    className={cn(
                      "font-display text-ink-soft text-xs uppercase tracking-wide",
                      gi === 0 ? "mb-2" : "mt-10 mb-2",
                    )}
                  >
                    {group.label}
                  </p>
                )}
                <ul>
                  {group.posts.map((post) => (
                    <PostRow
                      ident={ident}
                      iconPath={iconPath}
                      key={post.rkey}
                      post={post}
                    />
                  ))}
                </ul>
              </Fragment>
            ))
          )
        ) : (
          <p className="mt-8 text-ink-soft text-lg italic leading-relaxed">
            Nothing published yet — when @{ident} starts writing, posts will
            appear here.
          </p>
        )}
        {nextCursor && (
          // Calm register: a quiet text link, no buttons, no page numbers.
          <p className="mt-12 border-rule border-t pt-6">
            <a
              className="font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href={`/@${encodeURIComponent(ident)}?cursor=${encodeURIComponent(nextCursor)}`}
            >
              Older posts →
            </a>
          </p>
        )}
        <footer className="mt-16 border-rule border-t pt-6">
          {/* Whisper-level platform credit (two-surface rule). */}
          <p className="font-display text-ink-soft/80 text-xs">
            Published by its author on the open network ·{" "}
            <a
              className="transition-colors hover:text-ink"
              href={`${CANONICAL_ORIGIN}/`}
            >
              via Goldroad
            </a>{" "}
            ·{" "}
            <a
              className="transition-colors hover:text-ink"
              href={`/@${encodeURIComponent(ident)}/rss.xml`}
            >
              RSS
            </a>{" "}
            · <ReportLink />
          </p>
        </footer>
      </main>
    </div>
  );
}

function PublicationNotFound({ data }: { data?: unknown } = {}) {
  if (isHiddenNotFound(data)) return <ContentUnavailable />;
  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-24">
        <p className="font-display font-semibold text-ink-soft text-sm">
          Nothing at this address
        </p>
        <h1 className="mt-3 text-balance font-semibold text-3xl leading-[1.15]">
          No publication answers to this handle.
        </h1>
        <p className="mt-4 max-w-[52ch] text-ink-soft text-lg leading-relaxed">
          Check the spelling — or the account may have moved to a new handle,
          which is theirs to do.
        </p>
        <p className="mt-8 font-display text-ink-soft text-sm">
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="/"
          >
            Goldroad — writer-owned publishing
          </a>
        </p>
      </main>
    </div>
  );
}
