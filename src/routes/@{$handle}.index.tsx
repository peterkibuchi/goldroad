import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  ContentUnavailable,
  formatDate,
  isHiddenNotFound,
  ReportLink,
} from "~/components/document-article";
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

/**
 * Public publication page — calm register. Everything
 * is read from the writer's own PDS over public XRPC: the publication record
 * (name/description) and one 50-document page of site.standard.document
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
      const posts = docs
        .flatMap((r) => {
          const rkey = rkeyFromUri(r.uri);
          if (!rkey || typeof r.value.title !== "string") return [];
          const coverCid = coverImageCid(r.value.coverImage);
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

function PublicationPage() {
  const { ident, publication, posts, nextCursor } = Route.useLoaderData();
  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-16 md:py-24">
        <header className="mb-4 border-ink border-b pb-8">
          <h1 className="text-balance font-semibold text-4xl text-ink leading-[1.1] md:text-5xl">
            {publication?.name ?? ident}
          </h1>
          <p className="mt-3 font-display text-ink-soft text-sm">@{ident}</p>
          {publication?.description ? (
            <p className="mt-5 max-w-[52ch] text-ink-soft text-lg italic leading-relaxed">
              {publication.description}
            </p>
          ) : null}
        </header>
        {posts.length > 0 ? (
          <ul>
            {posts.map((post) => {
              const date = formatDate(post.publishedAt ?? undefined);
              return (
                <li className="border-rule border-b" key={post.rkey}>
                  <a
                    className="group flex items-start gap-5 py-7"
                    href={`/@${encodeURIComponent(ident)}/${encodeURIComponent(post.rkey)}`}
                  >
                    <span className="min-w-0 flex-1">
                      <h2 className="text-balance font-semibold text-ink text-xl leading-snug group-hover:underline group-hover:underline-offset-4">
                        {post.title}
                      </h2>
                      {post.description ? (
                        <p className="mt-2 line-clamp-2 text-base text-ink-soft leading-relaxed">
                          {post.description}
                        </p>
                      ) : null}
                      {date && (
                        <p className="mt-3 font-display text-ink-soft text-sm">
                          <time dateTime={post.publishedAt ?? undefined}>
                            {date}
                          </time>
                        </p>
                      )}
                    </span>
                    {post.coverPath && (
                      // Decorative thumbnail — the title is the row's text.
                      <img
                        alt=""
                        className="mt-1 h-20 w-20 shrink-0 object-cover"
                        loading="lazy"
                        src={post.coverPath}
                      />
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-8 text-ink-soft text-lg italic leading-relaxed">
            Nothing published yet — when @{ident} starts writing, posts will
            appear here.
          </p>
        )}
        {nextCursor && (
          // Calm register: a quiet text link, no buttons, no page numbers.
          <p className="mt-10">
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
