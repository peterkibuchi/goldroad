import { createFileRoute, notFound } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import {
  ContentUnavailable,
  formatDate,
  isHiddenNotFound,
  ReportLink,
} from "~/components/document-article";
import { SearchIcon } from "~/components/icons";
import { MAIN_CONTENT_ID } from "~/components/skip-link";
import { SubscribeControl } from "~/components/subscribe-control";
import { WriterSurface } from "~/components/writer-surface";
import { filterPostsByQuery, groupPostsByMonth } from "~/lib/archive";
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
import { documentBodyMarkdown } from "~/lib/document-content";
import { checkHidden } from "~/lib/moderation";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { formatReadingTime, listItemReadingMinutes } from "~/lib/reading-time";
import { type BasicTheme, parseTheme } from "~/lib/theme";
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
      // Author-level takedown: a hidden DID stops
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
      // Publication identity image (the
      // lexicon field already existed, nothing ever rendered it). Served
      // through the same /img proxy as document covers.
      const iconCid = coverImageCid(publication?.icon);
      const posts = docs
        .flatMap((r) => {
          const rkey = rkeyFromUri(r.uri);
          if (!rkey || typeof r.value.title !== "string") return [];
          const coverCid = coverImageCid(r.value.coverImage);
          const body = documentBodyMarkdown(r.value);
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
              readingMinutes: listItemReadingMinutes(body),
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
        // The author's own colours, if their publication record carries a
        // valid site.standard.theme.basic. Any author's — a Leaflet or pckt
        // writer's page renders here in the theme they set over there,
        // because it is the same record shape in the same lexicon. Invalid
        // or absent both come back null and the page keeps our default
        // palette (see parseTheme: a theme is never half-applied).
        theme: parseTheme(publication?.basicTheme),
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
        // A description always, so a shared archive link is never a bare title.
        // Most publications carry one; records written by other apps often do
        // not, and that is the common case here because these pages render ANY
        // atproto author. The fallback matches the feed's own wording.
        ...(() => {
          const description =
            publication?.description?.trim() || `Writing by @${ident}`;
          return [
            { name: "description", content: description },
            { property: "og:description", content: description },
          ];
        })(),
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

/**
 * Thumbnail slot for an archive row — a cover if the post has one, else the
 * publication's own icon, else NOTHING.
 *
 * It used to fall back to the title's first letter in a grey box, to keep every
 * row the same width. That box was the wrong trade: a lone capital in a tinted
 * square reads as a broken image rather than as a design, and a title starting
 * with O or I gives you a grey square containing what looks like a zero or a
 * stray rule. The row's rhythm comes from its consistent vertical padding, not
 * from a placeholder — so a post with no picture simply gets the full width for
 * its words, which is what an archive of writing should do anyway.
 */
export function PostThumb({
  coverPath,
  iconPath,
}: {
  coverPath: string | null;
  iconPath: string | null;
}) {
  if (!coverPath && !iconPath) return null;
  return (
    <img
      alt=""
      className="mt-1 h-20 w-20 shrink-0 object-cover"
      loading="lazy"
      src={(coverPath ?? iconPath) as string}
    />
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
          {/* Display face, matching the post page this row leads to. */}
          <h2 className="text-balance font-bold font-display text-[1.375rem] text-ink leading-snug tracking-[-0.01em] group-hover:underline group-hover:underline-offset-4">
            {post.title}
          </h2>
          {post.description ? (
            <p className="mt-2 line-clamp-2 font-display text-[0.9375rem] text-ink-soft leading-[1.55]">
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
        <PostThumb coverPath={post.coverPath} iconPath={iconPath} />
      </a>
    </li>
  );
}

function PublicationPage() {
  // Spread, for the same reason the document route does it: the loader
  // returns exactly the facts the page renders, and hand-picking them is how
  // one quietly goes missing. `publicationAtUri` was head-only until the
  // subscribe control needed the record a subscription points at.
  return <PublicationView {...Route.useLoaderData()} />;
}

/** The publication page itself, props-in — exported for tests, not a route. */
export function PublicationView({
  ident,
  publication,
  publicationAtUri,
  posts,
  nextCursor,
  iconPath,
  theme,
}: {
  ident: string;
  publication: StandardPublication | null;
  /** The publication record's URI — what a subscription points at. Null for an
   * author with no publication record, who has nothing to subscribe to yet. */
  publicationAtUri?: string | null;
  posts: ArchivePost[];
  nextCursor: string | null;
  iconPath: string | null;
  /** The author's validated theme, or null for our default palette. */
  theme?: BasicTheme | null;
}) {
  const [query, setQuery] = useState("");
  const filtered = filterPostsByQuery(posts, query);
  const isSearching = query.trim() !== "";
  const groups = isSearching
    ? [{ label: null as string | null, posts: filtered }]
    : groupPostsByMonth(filtered);

  return (
    // The writer's surface, not ours: their theme applies here, our dark-mode
    // toggle deliberately does not (see WriterSurface and styles.css).
    <WriterSurface theme={theme}>
      <main
        className="mx-auto max-w-[42rem] px-6 py-16 md:py-24"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
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
              {/* Same pairing as a post's header: display for the furniture,
                  serif kept for reading matter. It was one serif doing every
                  job here too, which meant walking from this page into a post
                  changed typographic voice halfway through the journey.

                  Smaller than it was (5xl→6xl was set before the post title
                  came down to 32px, and a masthead shouting over the headlines
                  beneath it inverts what the page is for). Negative tracking
                  for the same reason the post title takes it. */}
              <h1 className="wrap-anywhere text-balance font-bold font-display text-[2.25rem] text-ink leading-[1.1] tracking-[-0.02em]">
                {publication?.name ?? ident}
              </h1>
              <p className="mt-3 font-display text-ink-soft text-sm tracking-wide">
                @{ident}
              </p>
              {publication?.description ? (
                // Roman, not italic. Italic had become a default soft voice
                // across the product rather than an emphasis, which costs it
                // all meaning — the same correction the post dek got.
                <p className="mt-5 font-display text-[0.9375rem] text-ink-soft leading-[1.55]">
                  {publication.description}
                </p>
              ) : null}
              {/* Under the identity it belongs to, inside the masthead rule —
                  the one place on this page where an act on the publication
                  makes sense. Ink, because the accent moment on a reading
                  surface is the writer's, not ours (see SubscribeControl). */}
              <SubscribeControl
                className="mt-6"
                publicationAtUri={publicationAtUri ?? null}
              />
            </div>
          </div>
        </header>
        {posts.length > 0 && (
          // Sort/search row: "Latest" is the only real sort today (no view
          // or reply-count signal yet to back Top/Discussions) — the row is
          // laid out so those can join later, but a tab that doesn't work
          // yet is never rendered.
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-rule border-b pb-3">
            <nav aria-label="Sort posts">
              <span className="font-display font-semibold text-ink text-sm uppercase tracking-wide">
                Latest
              </span>
            </nav>
            <label className="flex items-center gap-2 text-ink-soft">
              <SearchIcon className="h-4 w-4 shrink-0" />
              <span className="sr-only">Search posts</span>
              {/* 16px at base, 14px from `sm:` up. iOS Safari zooms the page
                  in on a focused control under 16px and never zooms back out,
                  and this is a public page: searching the archive is often a
                  phone visitor's first interaction with it. */}
              <input
                className="w-28 bg-transparent font-display text-base text-ink placeholder:text-ink-soft/60 focus:w-48 focus:outline-none sm:text-sm"
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
            {/* A plain anchor, deliberately: the page turn must be a SERVER
                navigation. `?cursor=` responses are what the edge read-cache
                keys on (~/lib/read-cache), and this route's loader reads a
                third-party PDS over public XRPC — in the visitor's browser that
                loses the cache, and the reads themselves are not dependable
                cross-origin (no guaranteed CORS, and the no-follow fetch yields
                an opaque redirect). Keep the cache and the loader on the
                server. */}
            <a
              className="font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href={`/@${encodeURIComponent(ident)}?cursor=${encodeURIComponent(nextCursor)}`}
            >
              Older posts →
            </a>
          </p>
        )}
        {/* Same close as the article page: the writer's items lead, Goldroad
            gets one printer's-mark line last (two-surface rule). */}
        <footer className="mt-16 border-rule border-t pt-6">
          <p className="font-display text-ink-soft/80 text-xs">
            Published by its author on the open network ·{" "}
            <a
              className="transition-colors hover:text-ink"
              href={`/@${encodeURIComponent(ident)}/rss.xml`}
            >
              RSS
            </a>
          </p>
          <p className="mt-1 font-display text-ink-soft/80 text-xs">
            <a
              className="transition-colors hover:text-ink"
              href={`${CANONICAL_ORIGIN}/open`}
            >
              Goldroad — open-source, writer-owned publishing
            </a>{" "}
            · <ReportLink />
          </p>
        </footer>
      </main>
    </WriterSurface>
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
