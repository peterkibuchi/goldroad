import { notFound, useLocation } from "@tanstack/react-router";

import { ExternalLink } from "~/components/external-link";
import { HeartIcon, ReplyIcon, RepostIcon } from "~/components/icons";
import { Prose } from "~/components/prose";
import {
  getRecordEntry,
  isDid,
  isHandle,
  listRecordsPage,
  NotFoundError,
  parseAtUri,
  RKEY_RE,
  resolveDidToPds,
  resolveHandleToDid,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import {
  bskyProfileUrl,
  type DocumentEngagement,
  getDocumentEngagement,
} from "~/lib/engagement";
import { buildArticleJsonLd, jsonLdScriptContent } from "~/lib/json-ld";
import { checkMirror, type MirrorInfo } from "~/lib/mirror";
import { checkHidden, recordAtUri } from "~/lib/moderation";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { composeDocumentUrl } from "~/lib/publish";
import { documentReadingMinutes, formatReadingTime } from "~/lib/reading-time";
import {
  RELATED_POSTS_LIMIT,
  type RelatedPost,
  selectRelatedPosts,
} from "~/lib/related-posts";

/** A validated cover/icon image reference, serveable through /img/$did/$cid. */
export type CoverRef = { did: string; cid: string };

/**
 * Public reading surface — calm register: serif body,
 * ~65ch measure, hairline rules, no vermillion. The writer's words dominate;
 * the platform disappears. Shared by /p/$handle/$rkey (v0 URL, kept alive —
 * published records point at it) and /@$handle/$rkey (canonical composed URL).
 *
 * Content comes straight from the writer's PDS: markdown/plaintext rendered
 * via <Prose> (react-markdown, raw HTML inert) — never dangerouslySetInnerHTML.
 */
export async function loadDocument(identParam: string, rkey: string) {
  let ident: string;
  try {
    // A lone "%" in the path throws URIError — a malformed address is a
    // 404, never a 5xx (same invariant as the /img route).
    ident = decodeURIComponent(identParam);
  } catch {
    throw notFound();
  }
  if (!isHandle(ident) && !isDid(ident)) throw notFound();
  // rkey gets interpolated into the page's at:// link tags — reject malformed
  // keys here instead of trusting the PDS's 404.
  if (!RKEY_RE.test(rkey)) throw notFound();
  try {
    const did = isDid(ident) ? ident : await resolveHandleToDid(ident);
    // Takedown check before the PDS reads (moderation kit, audit #1): a hidden
    // author or record returns a calm 404 notice, never the writer's content.
    if (
      await checkHidden({
        data: { did, atUri: recordAtUri(did, "site.standard.document", rkey) },
      })
    ) {
      // Takedown → a 404 carrying a marker the notFoundComponent reads to show
      // the "unavailable" notice instead of the generic not-found copy.
      throw notFound({ data: { hidden: true } });
    }
    const pds = await resolveDidToPds(did);
    const entry = await getRecordEntry<StandardDocument>(
      pds,
      did,
      "site.standard.document",
      rkey,
    );
    const doc = entry.value;

    // The document's publication (same-repo at:// site refs only) — backs
    // the standard.site canonical URL (publication.url + document.path), the
    // byline's name/icon, and the end-of-post follow-card's description.
    const siteRef = typeof doc.site === "string" ? parseAtUri(doc.site) : null;
    const pubPromise =
      siteRef &&
      siteRef.did === did &&
      siteRef.collection === "site.standard.publication"
        ? getRecordEntry<StandardPublication>(
            pds,
            siteRef.did,
            siteRef.collection,
            siteRef.rkey,
          ).catch(() => null)
        : Promise.resolve(null);

    // "More from @handle" (owner decision #3: same-writer only) — a small
    // extra page of the writer's own document records, same call shape the
    // archive page already makes. A short buffer over the display limit
    // covers the current document (and a few unkeyed/untitled records)
    // without needing a second round trip.
    const relatedPromise = listRecordsPage<StandardDocument>(
      pds,
      did,
      "site.standard.document",
      { limit: RELATED_POSTS_LIMIT + 3 },
    ).catch(() => ({ records: [], cursor: null }));

    // Cross-network engagement (owner decision #2): announced-only, cached,
    // and NEVER allowed to fail the page — every error degrades to null.
    const engagementPromise = getDocumentEngagement(doc.bskyPostRef).catch(
      () => null,
    );

    // Mirror lookup (import ledger): a hit swaps the canonical tag for
    // noindex and adds the "Originally published at …" line below. Null =
    // native post, adopted mirror, or a flaked read (fail open).
    const mirrorPromise = checkMirror({ data: { did, rkey } });

    const [pub, relatedPage, engagement, mirror] = await Promise.all([
      pubPromise,
      relatedPromise,
      engagementPromise,
      mirrorPromise,
    ]);

    let publicationUrl: string | undefined;
    let publicationName: string | null = null;
    let publicationDescription: string | null = null;
    let publicationIcon: CoverRef | null = null;
    if (typeof pub?.value.url === "string") publicationUrl = pub.value.url;
    if (typeof pub?.value.name === "string" && pub.value.name.trim() !== "")
      publicationName = pub.value.name;
    if (
      typeof pub?.value.description === "string" &&
      pub.value.description.trim() !== ""
    ) {
      publicationDescription = pub.value.description;
    }
    const iconCid = coverImageCid(pub?.value.icon);
    if (iconCid) publicationIcon = { did, cid: iconCid };

    const coverCid = coverImageCid(doc.coverImage);
    return {
      doc,
      ident,
      publicationName,
      publicationDescription,
      publicationIcon,
      mirror,
      relatedPosts: selectRelatedPosts(relatedPage.records, rkey),
      engagement,
      // Validated cover blob (allowlisted raster, within the lexicon cap) —
      // rendered via the /img proxy so the PDS hostname never leaks into HTML.
      cover: coverCid ? ({ did, cid: coverCid } satisfies CoverRef) : null,
      // The page's record reference for the standard.site link-tag convention.
      atUri: `at://${did}/site.standard.document/${rkey}`,
      canonicalUrl: composeDocumentUrl({
        site: doc.site,
        path: doc.path,
        publicationUrl,
      }),
    };
  } catch (err) {
    if (err instanceof NotFoundError) throw notFound();
    throw err;
  }
}

/**
 * Interop + SEO head for document pages. The link-tag convention is
 * interop-load-bearing: consumers (incl. Bluesky's crawler) discover the
 * backing atproto record via `rel="site.standard.document"` pointing at the
 * record's AT-URI (standard.site/docs/quick-start; verified 2026-07-23 against
 * a live Leaflet page, which emits rel="canonical" + rel="alternate" +
 * rel="site.standard.document" exactly as below).
 */
export function documentHead(
  loaderData:
    | {
        doc: StandardDocument;
        ident: string;
        atUri: string;
        canonicalUrl: string | null;
        cover?: CoverRef | null;
        mirror?: MirrorInfo | null;
        publicationName?: string | null;
      }
    | undefined,
) {
  if (!loaderData) return { meta: [{ title: "Not found" }] };
  const { doc, ident, atUri, canonicalUrl, cover, mirror, publicationName } =
    loaderData;
  const title = `${doc.title ?? "Untitled"} — ${ident}`;
  const imageUrl = cover
    ? `${CANONICAL_ORIGIN}${blobImagePath(cover.did, cover.cid)}`
    : null;
  // Mirrored posts (the original lives elsewhere): noindex INSTEAD of a
  // canonical tag — search engines index the original, not this copy; a
  // cross-domain canonical is no longer the recommended syndication signal
  // and could never verify against a domain the writer doesn't control.
  // The at:// link tags stay: they're record discovery, not SEO.
  const isMirror = mirror != null;
  return {
    meta: [
      { title },
      ...(isMirror ? [{ name: "robots", content: "noindex" }] : []),
      ...(doc.description
        ? [
            { name: "description", content: doc.description },
            { property: "og:description", content: doc.description },
          ]
        : []),
      { property: "og:title", content: doc.title ?? "Untitled" },
      { property: "og:type", content: "article" },
      ...(canonicalUrl ? [{ property: "og:url", content: canonicalUrl }] : []),
      // og:image must be absolute — minted from the canonical origin
      // (never the request origin), served through our own /img proxy.
      ...(imageUrl ? [{ property: "og:image", content: imageUrl }] : []),
    ],
    links: [
      ...(canonicalUrl && !isMirror
        ? [{ rel: "canonical", href: canonicalUrl }]
        : []),
      { rel: "alternate", href: atUri },
      { rel: "site.standard.document", href: atUri },
      // Feed discovery: document pages advertise their PUBLICATION's feed
      // (there is no per-document feed), minted from the canonical origin.
      {
        rel: "alternate",
        type: "application/rss+xml",
        title: `@${ident} — RSS`,
        href: `${CANONICAL_ORIGIN}/@${encodeURIComponent(ident)}/rss.xml`,
      },
    ],
    // schema.org Article — headline/dates/author/publisher for search and
    // social consumers that read structured data instead of (or alongside)
    // OpenGraph tags. See ~/lib/json-ld for the escaping rationale: this is
    // the one narrow, justified exception to "no dangerouslySetInnerHTML"
    // in this codebase, and it carries zero literal `<` after escaping.
    scripts: [
      {
        tag: "script",
        attrs: { type: "application/ld+json" },
        children: jsonLdScriptContent(
          buildArticleJsonLd({
            headline: doc.title ?? "Untitled",
            publishedAt: doc.publishedAt,
            updatedAt: doc.updatedAt,
            authorName: ident,
            publisherName: publicationName ?? ident,
            url: canonicalUrl,
            imageUrl,
          }),
        ),
      },
    ],
  };
}

/**
 * Whisper-level "Report" link for reading surfaces (moderation kit, audit #1):
 * carries the current page's canonical URL to the /report form so the reporter
 * doesn't retype it. `useLocation` keeps it right on both SSR and client nav.
 */
export function ReportLink({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const href = `/report?url=${encodeURIComponent(`${CANONICAL_ORIGIN}${pathname}`)}`;
  return (
    <a className={className ?? "transition-colors hover:text-ink"} href={href}>
      Report
    </a>
  );
}

export function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Fixed locale + UTC: identical output on server and client (no hydration drift).
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Display host for a provenance URL ("writer.substack.com"), or null. */
function provenanceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** True when at least one engagement metric is actually counted — an
 * announced post whose AppView entry carries zero counted fields (all
 * `undefined`) renders nothing, same as an unannounced one (owner decision
 * #2: honest silence, never a false zero). */
function hasCountedEngagement(counts: DocumentEngagement["counts"]): boolean {
  return (
    counts.likeCount !== undefined ||
    counts.replyCount !== undefined ||
    counts.repostCount !== undefined ||
    counts.quoteCount !== undefined
  );
}

/** Quiet like/reply/repost+quote row (owner decision #2) — only the reply
 * count is a link, to the bsky.app thread ("the network is the comment
 * section"). Plain ink-soft icon+number pairs, never a
 * colored badge — this must not read as generic social-media chrome. */
function EngagementRow({ engagement }: { engagement: DocumentEngagement }) {
  const { counts, threadUrl } = engagement;
  const reposts = (counts.repostCount ?? 0) + (counts.quoteCount ?? 0);
  const showReposts =
    counts.repostCount !== undefined || counts.quoteCount !== undefined;
  return (
    <div className="mb-10 flex items-center gap-6 border-rule border-b pb-6 font-display text-ink-soft text-sm">
      {counts.likeCount !== undefined && (
        <span
          className="inline-flex items-center gap-1.5"
          title={`${counts.likeCount} likes on Bluesky`}
        >
          <HeartIcon className="h-4 w-4" />
          {counts.likeCount}
        </span>
      )}
      {counts.replyCount !== undefined && (
        <ExternalLink
          className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
          href={threadUrl}
          title="View replies on Bluesky"
        >
          <ReplyIcon className="h-4 w-4" />
          {counts.replyCount}
        </ExternalLink>
      )}
      {showReposts && (
        <span
          className="inline-flex items-center gap-1.5"
          title={`${reposts} reposts and quotes on Bluesky`}
        >
          <RepostIcon className="h-4 w-4" />
          {reposts}
        </span>
      )}
    </div>
  );
}

export function DocumentArticle({
  doc,
  ident,
  publicationName,
  publicationDescription,
  publicationIcon,
  cover,
  mirror,
  relatedPosts,
  engagement,
}: {
  doc: StandardDocument;
  ident: string;
  publicationName?: string | null;
  publicationDescription?: string | null;
  publicationIcon?: CoverRef | null;
  cover?: CoverRef | null;
  mirror?: MirrorInfo | null;
  relatedPosts?: RelatedPost[];
  engagement?: DocumentEngagement | null;
}) {
  const body = doc.textContent ?? "";
  const date = formatDate(doc.publishedAt);
  const updated = formatDate(doc.updatedAt);
  const publicationHref = `/@${encodeURIComponent(ident)}`;
  const mirrorHost = mirror ? provenanceHost(mirror.sourceUrl) : null;
  const readingLabel = formatReadingTime(documentReadingMinutes(body));
  // Owner decision #1: the dek is ALWAYS shown when set — no longer just a
  // no-body fallback — as its own line under the H1.
  const dek = doc.description?.trim() || null;

  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <article className="mx-auto max-w-[42rem] px-6 py-16 md:py-24">
        {cover && (
          // Fixed aspect box reserves the layout slot before the image
          // loads (no lexicon width/height metadata exists to size it
          // otherwise) — zero CLS regardless of the writer's source
          // dimensions. Decorative on the page (the adjacent title names
          // the piece); calm register — no border ornament, the image
          // speaks alone.
          <div className="mb-10 aspect-video w-full overflow-hidden bg-ink/5">
            <img
              alt=""
              className="h-full w-full object-cover"
              src={blobImagePath(cover.did, cover.cid)}
            />
          </div>
        )}
        <header className="mb-10 border-rule border-b pb-8">
          <h1 className="text-balance font-semibold text-4xl text-ink leading-[1.1] md:text-5xl">
            {doc.title ?? "Untitled"}
          </h1>
          {dek && (
            <p className="mt-4 text-ink-soft text-xl italic leading-relaxed">
              {dek}
            </p>
          )}
          {/* One byline row carries every attribution/metadata fact — the
              title (and now the dek) stand alone above it, carrying their
              own weight. Avatar-if-any sits inline with the name. */}
          <div className="mt-6 flex items-center gap-2.5 font-display text-ink-soft text-sm">
            {publicationIcon && (
              <img
                alt=""
                className="h-6 w-6 shrink-0 object-cover"
                src={blobImagePath(publicationIcon.did, publicationIcon.cid)}
              />
            )}
            <p>
              {publicationName && (
                <>
                  <a
                    className="transition-colors hover:text-ink"
                    href={publicationHref}
                  >
                    {publicationName}
                  </a>
                  {" · "}
                </>
              )}
              <a
                className="transition-colors hover:text-ink"
                href={publicationHref}
              >
                @{ident}
              </a>
              {date && (
                <>
                  {" · "}
                  <time dateTime={doc.publishedAt}>{date}</time>
                </>
              )}
              {readingLabel && <> · {readingLabel}</>}
              {updated && updated !== date && <span> · updated {updated}</span>}
            </p>
          </div>
          {/* Provenance for mirrored posts (import ledger): the original
              lives elsewhere and this page says so, visibly — the honest
              half of "keep your Substack". Calm register, no ornament. */}
          {mirror && mirrorHost && mirror.sourceUrl && (
            <p className="mt-2 font-display text-ink-soft text-sm">
              Originally published at{" "}
              <ExternalLink
                className="underline underline-offset-2 transition-colors hover:text-ink"
                href={mirror.sourceUrl}
              >
                {mirrorHost}
              </ExternalLink>
            </p>
          )}
        </header>
        {/* Engagement row (owner decision #2): announced posts only, and
            only when the AppView actually returned a counted metric —
            silence, never a placeholder or a false zero. */}
        {engagement && hasCountedEngagement(engagement.counts) && (
          <EngagementRow engagement={engagement} />
        )}
        {body.trim() !== "" ? (
          <Prose markdown={body} />
        ) : (
          <p className="font-display text-ink-soft text-sm">
            This document keeps its full text elsewhere
            {doc.site?.startsWith("https://") ? (
              <>
                {" — "}
                {/* Third-party canonical home (e.g. *.leaflet.pub): new tab. */}
                <ExternalLink
                  className="underline underline-offset-2"
                  href={`${doc.site}${doc.path ?? ""}`}
                >
                  read it at the source
                </ExternalLink>
              </>
            ) : null}
            .
          </p>
        )}
        <aside className="mt-16 border-rule border-t pt-10">
          {/* End-of-post follow-card — the honest stand-in for a subscribe
              card until newsletters ship (the "inline subscribe
              card", adapt-lite verdict). Frictionless and native: it links
              straight to the writer's own Bluesky profile. */}
          <div className="border border-rule p-6">
            <p className="font-display font-semibold text-base text-ink">
              {publicationName ?? `@${ident}`}
            </p>
            {publicationDescription && (
              <p className="mt-2 text-base text-ink-soft leading-relaxed">
                {publicationDescription}
              </p>
            )}
            <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 font-display text-sm">
              <ExternalLink
                className="font-semibold text-ink underline underline-offset-2 transition-colors hover:text-ink-soft"
                href={bskyProfileUrl(ident)}
              >
                Follow @{ident} on Bluesky
              </ExternalLink>
              <a
                className="text-ink-soft underline underline-offset-2 transition-colors hover:text-ink"
                href={`${publicationHref}/rss.xml`}
              >
                RSS
              </a>
            </p>
          </div>
          {relatedPosts && relatedPosts.length > 0 && (
            <div className="mt-10">
              <p className="font-display font-semibold text-ink-soft text-xs uppercase tracking-wide">
                More from {publicationName ?? `@${ident}`}
              </p>
              <ul>
                {relatedPosts.map((post) => {
                  const postDate = formatDate(post.publishedAt ?? undefined);
                  return (
                    <li
                      className="border-rule border-t py-4 first:border-t-0"
                      key={post.rkey}
                    >
                      <a
                        className="font-semibold text-ink leading-snug hover:underline hover:underline-offset-4"
                        href={`${publicationHref}/${encodeURIComponent(post.rkey)}`}
                      >
                        {post.title}
                      </a>
                      {postDate && (
                        <p className="mt-1 font-display text-ink-soft text-xs uppercase tracking-wide">
                          <time dateTime={post.publishedAt ?? undefined}>
                            {postDate}
                          </time>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </aside>
        {/* Whisper-level platform credit (two-surface rule: the writer owns
            this page; Goldroad stays out of the way). */}
        <footer className="mt-10 border-rule border-t pt-6">
          <p className="font-display text-ink-soft/80 text-xs">
            Published by its author on the open network ·{" "}
            <a
              className="transition-colors hover:text-ink"
              href={`${CANONICAL_ORIGIN}/`}
            >
              via Goldroad
            </a>{" "}
            · <ReportLink />
          </p>
        </footer>
      </article>
    </div>
  );
}

/** True when a thrown notFound carries our takedown marker (moderation kit). */
export function isHiddenNotFound(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "hidden" in data &&
    data.hidden === true
  );
}

export function DocumentNotFound({ data }: { data?: unknown } = {}) {
  if (isHiddenNotFound(data)) return <ContentUnavailable />;
  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-24">
        <p className="font-display font-semibold text-ink-soft text-sm">
          Nothing at this address
        </p>
        <h1 className="mt-3 text-balance font-semibold text-3xl leading-[1.15]">
          This page isn't published.
        </h1>
        <p className="mt-4 max-w-[52ch] text-ink-soft text-lg leading-relaxed">
          The handle may be misspelled, or the writer may have taken this post
          down — their archive, their call.
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

/**
 * Takedown state (moderation kit, audit #1): the author or record is on the
 * hide-list, so we don't serve it. Calm register, honest and non-accusatory —
 * we don't reveal who reported it or why. Rendered with a 451 status.
 */
export function ContentUnavailable() {
  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-24">
        <p className="font-display font-semibold text-ink-soft text-sm">
          Unavailable
        </p>
        <h1 className="mt-3 text-balance font-semibold text-3xl leading-[1.15]">
          This content is unavailable.
        </h1>
        <p className="mt-4 max-w-[52ch] text-ink-soft text-lg leading-relaxed">
          Goldroad isn't serving this page. If you believe that's a mistake, our{" "}
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="/policies"
          >
            content policies
          </a>{" "}
          explain how to reach us. The underlying record, if it still exists,
          lives in its author's own repo on the open network.
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
