import { Await, notFound, redirect, useLocation } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";

import { Conversation } from "~/components/conversation";
import { ExternalLink } from "~/components/external-link";
import { HeartIcon, ReplyIcon, RepostIcon } from "~/components/icons";
import { Prose } from "~/components/prose";
import { ReaderEmailCapture } from "~/components/reader-email-capture";
import { MAIN_CONTENT_ID } from "~/components/skip-link";
import { SubscribeControl } from "~/components/subscribe-control";
import { WriterSurface } from "~/components/writer-surface";
import {
  clearEdition,
  currentEdition,
  type Edition,
  setEdition,
} from "~/lib/appearance";
import {
  type Did,
  getRecordEntry,
  isDid,
  isHandle,
  listRecords,
  listRecordsPage,
  NotFoundError,
  parseAtUri,
  RKEY_RE,
  refreshReaderPds,
  resolveHandleToDid,
  resolveReaderPds,
  rkeyFromUri,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import { getPostConversation, type PostConversation } from "~/lib/comments";
import { documentBodyMarkdown } from "~/lib/document-content";
import {
  bskyProfileUrl,
  type DocumentEngagement,
  getDocumentEngagement,
  hasVisibleEngagement,
  isWorthShowing,
} from "~/lib/engagement";
import { findFormerHandle, formerHandleRedirect } from "~/lib/handle-history";
import { buildArticleJsonLd, jsonLdScriptContent } from "~/lib/json-ld";
import { checkMirror, keepsCanonical, type MirrorInfo } from "~/lib/mirror";
import { checkHidden, recordAtUri } from "~/lib/moderation";
import {
  CANONICAL_ORIGIN,
  isCanonicalOriginUrl,
  onCanonicalOrigin,
  readerPageUrl,
} from "~/lib/origin";
import { composeDocumentUrl, publicationBase } from "~/lib/publish";
import { documentReadingMinutes, formatReadingTime } from "~/lib/reading-time";
import {
  RELATED_POSTS_LIMIT,
  type RelatedPost,
  selectRelatedPosts,
} from "~/lib/related-posts";
import { DEFAULT_CARD_META } from "~/lib/social-card";
import { type BasicTheme, parseTheme } from "~/lib/theme";
import { utcLongDate } from "~/lib/utc-date";

/** A validated cover/icon image reference, serveable through /img/$did/$cid. */
type CoverRef = { did: string; cid: string };

/**
 * Upstream budget for the two below-the-fold AppView reads on this page — the
 * like/reply counts and the reply list.
 *
 * Both modules already cap their own fetches (5 s in ~/lib/engagement, 3 s in
 * ~/lib/comments). Those ceilings are right for the dashboard's batched reads,
 * where the writer is looking at their own numbers and waiting is the honest
 * answer. They are far too long HERE: both are streamed to readers, but
 * crawlers and link-preview scrapers wait for the whole page (the router
 * renders all of it for bots), so on a cold render against a slow AppView it
 * is the AppView — not the writer's words — that decides when a scraper gets
 * its first byte, and a link-preview scraper has given up long before 5 s.
 * Both already degrade to `null` on every failure including timeout, and each
 * keeps its own 300 s edge cache, so the tighter leash costs a counts row on
 * an unlucky cold render and buys back seconds on the render a stranger's
 * first impression depends on.
 */
const READER_APPVIEW_BUDGET_MS = 1_500;

/** `fetch` with this page's render budget layered ON TOP of whatever the calling
 * module set, via AbortSignal.any — whichever deadline is shorter wins, so
 * neither this nor the module's own ceiling can be silently defeated. */
const budgetedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: AbortSignal.any(
      [init?.signal, AbortSignal.timeout(READER_APPVIEW_BUDGET_MS)].filter(
        (signal): signal is AbortSignal => signal != null,
      ),
    ),
  });

/**
 * Public reading surface — calm register: serif body,
 * ~65ch measure, hairline rules, no vermillion. The writer's words dominate;
 * the platform disappears. Shared by /p/$handle/$rkey (v0 URL, kept alive —
 * published records point at it) and /@$handle/$rkey (canonical composed URL).
 *
 * Content comes straight from the writer's PDS: the loader renders the body
 * once to sanitized HTML (~/lib/markdown-html), cached on the server.
 */
export async function loadDocument(
  identParam: string,
  rkey: string,
  retried = false,
) {
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
  // Kept outside the try for the moved-PDS retry in the catch below.
  let did: Did | undefined;
  let pdsRead: string | undefined;
  try {
    did = isDid(ident) ? ident : await resolveIdent(ident, `/${rkey}`);

    // Two D1 reads and one plc.directory fetch, all of which need only the DID
    // and none of which need each other. They used to run one after another,
    // which put a D1 round trip on the critical path twice for no reason. The
    // takedown check is STILL awaited before any PDS read below — see the
    // Promise.all — so "no content is fetched for a hidden subject" holds
    // exactly as before; only the waiting is shared.
    const hiddenPromise = checkHidden({
      data: { did, atUri: recordAtUri(did, "site.standard.document", rkey) },
    });
    // Provenance lookup (import ledger): a feed mirror swaps the canonical
    // tag for noindex, a thread import keeps it, and both get a provenance
    // line (~/lib/mirror). Null = native post, adopted mirror, or a flaked
    // read (fail open). The `.catch`
    // is new with the concurrency: this promise can now outlive an early
    // throw below, and a floating rejection is an unhandled one.
    const mirrorPromise = checkMirror({ data: { did, rkey } }).catch(
      () => null,
    );
    // Deferred rather than awaited together, so the TAKEDOWN ANSWER STILL WINS
    // over every other failure. A plain `Promise.all` would reject with
    // whichever settled first, which for a hidden author on an unreachable
    // directory means the generic 404 instead of the takedown notice — a
    // regression in exactly the path that matters most. The error is held and
    // re-thrown below, unchanged, once the check has had its say.
    const pdsPromise = resolveReaderPds(did).catch((err: unknown) => ({
      pdsError: err,
    }));

    // Takedown check before the PDS reads: a hidden
    // author or record returns a calm 404 notice, never the writer's content.
    if (await hiddenPromise) {
      // Takedown → a 404 carrying a marker the notFoundComponent reads to show
      // the "unavailable" notice instead of the generic not-found copy.
      throw notFound({ data: { hidden: true } });
    }
    const resolvedPds = await pdsPromise;
    if (typeof resolvedPds !== "string") throw resolvedPds.pdsError;
    const pds = resolvedPds;
    pdsRead = pds;

    // "More from @handle" — same-writer only: a small extra page of the
    // writer's own document records, the same call shape the archive page
    // already makes. A short buffer over the display limit covers the current
    // document (and a few unkeyed/untitled records) without a second round trip.
    //
    // Started HERE rather than after the document read, because it needs only
    // `pds` + `did`: it is a second call to the same PDS and there is no reason
    // for it to queue behind the first one.
    const relatedPromise = listRecordsPage<StandardDocument>(
      pds,
      did,
      "site.standard.document",
      { limit: RELATED_POSTS_LIMIT + 3 },
    ).catch(() => ({ records: [], cursor: null }));

    // The writer's publications, listed alongside the document instead of
    // fetched after it. Which one the document belongs to is only known once
    // the document arrives, but writers have one or a few, so a single listing
    // nearly always holds it: one request, like the getRecord it replaces,
    // minus a whole PDS round trip of waiting. It is spent for nothing on a
    // document with no publication in this repo, and a writer with more than
    // ten pays for the direct read as well.
    const pubsPromise = listRecords<StandardPublication>(
      pds,
      did,
      "site.standard.publication",
      { limit: 10 },
    ).catch(() => null);

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
    // Read directly only when the listing didn't have it (more than ten
    // publications, or the listing failed).
    const siteRef = typeof doc.site === "string" ? parseAtUri(doc.site) : null;
    const pubPromise =
      siteRef &&
      siteRef.did === did &&
      siteRef.collection === "site.standard.publication"
        ? pubsPromise.then(
            (pubs) =>
              pubs?.find((r) => rkeyFromUri(r.uri) === siteRef.rkey) ??
              getRecordEntry<StandardPublication>(
                pds,
                siteRef.did,
                siteRef.collection,
                siteRef.rkey,
              ).catch(() => null),
          )
        : Promise.resolve(null);

    // Cross-network engagement: announced posts only, cached, and NEVER
    // allowed to fail the page — every error degrades to null. Streamed like
    // the replies below, for the same reason: the counts render under the
    // article, and awaiting them here made a like count a cold render's
    // TTFB whenever the AppView answered slower than the writer's PDS. Held
    // to this page's render budget (see budgetedFetch) for the bots that
    // wait for the whole page.
    const engagement = getDocumentEngagement(doc.bskyPostRef, did, {
      fetcher: budgetedFetch,
    }).catch(() => null);

    // The conversation: replies to the announcement, off the same ref.
    // Returned as a promise, NOT awaited: the replies render after the
    // colophon, far below the fold, so the page streams the article first and
    // the replies follow in the same response when the AppView answers.
    // Awaiting them here put a whole AppView round trip (and a thread's worth
    // of JSON) in front of the first byte. Degrades to null on absolutely
    // everything — ~/lib/comments already swallows its own failures; this
    // .catch is the belt to that braces, because nothing about replies may
    // fail this page. `did` is passed as the ref's expected repo: a
    // bskyPostRef aimed outside this writer's own repo is not this document's
    // conversation.
    const conversation = getPostConversation(doc.bskyPostRef, did, {
      fetcher: budgetedFetch,
    }).catch(() => null);

    // Rendered here, once, and shipped as HTML so hydration never re-parses
    // it. Started last: without a cache it renders synchronously. Imported
    // here rather than at the top: the loader is the only caller, and it runs
    // in the browser only on client-side navigation, so a page's first load
    // no longer downloads markdown-it.
    const body = documentBodyMarkdown(doc);
    const bodyHtmlPromise = import("~/lib/markdown-html")
      .then(({ renderBodies }) =>
        renderBodies([body], undefined, { embeds: true }),
      )
      .then(([html]) => html);

    const [pub, relatedPage, mirror, bodyHtml] = await Promise.all([
      pubPromise,
      relatedPromise,
      mirrorPromise,
      bodyHtmlPromise,
    ]);

    let publicationUrl: string | undefined;
    // What a subscription points at. Minted from the ref we already validated
    // (same repo, publication collection) rather than read off the getRecord
    // response, which can come back with an empty `uri` and is the writer's
    // PDS talking about itself either way.
    const publicationAtUri =
      pub && siteRef
        ? recordAtUri(did, siteRef.collection, siteRef.rkey)
        : null;
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
    // The author's colours travel with the publication the document belongs
    // to, wherever that publication was written — a Leaflet author's post
    // renders here in the theme they set in Leaflet. A loose document (an
    // https `site` with no publication record) has no theme to read, and gets
    // the default palette, which is the correct answer rather than a gap.
    const theme = parseTheme(pub?.value.basicTheme);

    const coverCid = coverImageCid(doc.coverImage);
    return {
      // The body travels as `bodyHtml`; its markdown and plaintext would only
      // add two more copies to the hydration payload.
      doc: { ...doc, content: undefined, textContent: undefined },
      bodyHtml,
      readingMinutes: documentReadingMinutes(body),
      ident,
      // The author's DID and their publication's own URL: between them they say
      // whose address an email capture would be held for, and whether this
      // instance hosts the publication at all (~/components/reader-email-capture).
      did,
      publicationUrl: publicationUrl ?? null,
      publicationName,
      publicationDescription,
      publicationIcon,
      publicationAtUri,
      theme,
      mirror,
      relatedPosts: selectRelatedPosts(relatedPage.records, rkey),
      engagement,
      conversation,
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
    if (err instanceof NotFoundError) {
      // The cached PDS refused: the writer may have moved since it was stored.
      if (!retried && did && pdsRead && (await refreshReaderPds(did, pdsRead)))
        return loadDocument(identParam, rkey, true);
      throw notFound();
    }
    throw err;
  }
}

/**
 * A handle to its DID for a reader route. A handle that no longer resolves
 * may be a writer's old one, minted into links before they changed it: those
 * redirect to the same `path` under the writer's current address.
 */
export async function resolveIdent(handle: string, path: string) {
  try {
    return await resolveHandleToDid(handle);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    const target = await findFormerHandle({ data: { handle } });
    if (target) throw redirect(formerHandleRedirect(target, path));
    throw notFound();
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
        /** The post's share card (the publication name, title and byline drawn
         * at 1200×630), once its record carries one. Leads the link preview
         * ahead of the cover, which stays the Article's image. */
        shareCard?: CoverRef | null;
        mirror?: MirrorInfo | null;
        publicationName?: string | null;
        publicationUrl?: string | null;
        publicationIcon?: CoverRef | null;
      }
    | undefined,
) {
  if (!loaderData) return { meta: [{ title: "Not found" }] };
  const {
    doc,
    ident,
    atUri,
    canonicalUrl,
    cover,
    shareCard,
    mirror,
    publicationName,
    publicationUrl,
    publicationIcon,
  } = loaderData;
  const headline = doc.title ?? "Untitled";
  const title = `${headline} — ${ident}`;
  const blobUrl = (ref: CoverRef) =>
    `${CANONICAL_ORIGIN}${blobImagePath(ref.did, ref.cid)}`;
  const imageUrl = cover ? blobUrl(cover) : null;
  // The site a link preview names (Slack and Discord print it above the
  // title): the writer's publication, not the host it happens to be read on.
  const siteName = publicationName ?? ident;
  // Mirrored posts (the original is SOMEONE ELSE'S publication, still up):
  // noindex INSTEAD of a canonical tag — search engines index the original, not
  // this copy; a cross-domain canonical is no longer the recommended
  // syndication signal and could never verify against a domain the writer
  // doesn't control. The at:// link tags stay: they're record discovery, not SEO.
  //
  // A thread self-import is NOT that case and keeps its canonical: the original
  // is the writer's own Bluesky thread, which was never an indexed web page
  // competing for the same query. noindex there would suppress the only
  // long-form copy of the writer's own words in favour of nothing at all. See
  // ~/lib/mirror.
  const isMirror = !keepsCanonical(mirror);
  // The base the canonical URL composes onto: the document's own https site,
  // else its publication's url.
  const base = publicationBase({ site: doc.site, publicationUrl });
  // The record's own address, moved onto the canonical origin when it was
  // minted on a legacy one. A record that composes none still gets one
  // canonical, whichever of /@ or /p/, handle casing or query it was reached
  // by: this page, when the writer's home is here or nowhere on the
  // web. A home on another site without a path to the post names nothing,
  // since this page is not where that post lives and guessing would say so.
  const rkey = rkeyFromUri(atUri);
  const pageUrl = canonicalUrl
    ? onCanonicalOrigin(canonicalUrl)
    : rkey && (base === null || isCanonicalOriginUrl(onCanonicalOrigin(base)))
      ? readerPageUrl(ident, rkey)
      : null;
  // The writer's home: that base, else their page here.
  const writerHome = base ?? readerPageUrl(ident);
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
      { property: "og:title", content: headline },
      { property: "og:type", content: "article" },
      ...(pageUrl ? [{ property: "og:url", content: pageUrl }] : []),
      { property: "og:site_name", content: siteName },
      // Open Graph's article tags: Facebook, LinkedIn and Slack read the dates
      // from here rather than from the JSON-LD. Record fields are untrusted,
      // so only a string a date parses from makes it in.
      ...(isDate(doc.publishedAt)
        ? [{ property: "article:published_time", content: doc.publishedAt }]
        : []),
      ...(isDate(doc.updatedAt)
        ? [{ property: "article:modified_time", content: doc.updatedAt }]
        : []),
      ...previewImageMeta({
        shareCardUrl: shareCard ? blobUrl(shareCard) : null,
        imageUrl,
        headline,
        publicationName,
        ident,
      }),
    ],
    links: [
      ...(pageUrl && !isMirror ? [{ rel: "canonical", href: pageUrl }] : []),
      { rel: "alternate", href: atUri },
      { rel: "site.standard.document", href: atUri },
      // Feed discovery: document pages advertise their PUBLICATION's feed
      // (there is no per-document feed), minted from the canonical origin.
      {
        rel: "alternate",
        type: "application/rss+xml",
        title: `@${ident} — RSS`,
        href: `${readerPageUrl(ident)}/rss.xml`,
      },
    ],
    // schema.org Article — headline/dates/author/publisher for search and
    // social consumers that read structured data instead of (or alongside)
    // OpenGraph tags. See ~/lib/json-ld for the escaping rationale: it
    // carries zero literal `<` after escaping.
    // Flat script props, NOT { tag, attrs, children }. This router types head
    // scripts as plain <script> props, so the nested shape spread `tag` and
    // `attrs` onto the element as literal attributes and dropped the real ones:
    // the rendered tag lost `type="application/ld+json"`, which made the browser
    // treat the JSON-LD as JavaScript and throw a SyntaxError on every document
    // page — while search engines, which only read that type, saw no structured
    // data at all. The tests asserted the returned object rather than the
    // rendered HTML, which is precisely why a green suite missed it.
    scripts: [
      {
        type: "application/ld+json",
        children: jsonLdScriptContent(
          buildArticleJsonLd({
            headline,
            description: doc.description,
            publishedAt: doc.publishedAt,
            updatedAt: doc.updatedAt,
            authorName: ident,
            authorUrl: writerHome,
            authorSameAs: [bskyProfileUrl(ident)],
            publisherName: siteName,
            publisherUrl: writerHome,
            publisherLogoUrl: publicationIcon ? blobUrl(publicationIcon) : null,
            url: pageUrl,
            mainEntityOfPage: isMirror ? null : pageUrl,
            imageUrl,
          }),
        ),
      },
    ],
  };
}

/**
 * The image a post's link preview shows, and the tags that describe it: the
 * share card when the record has one, else the cover, else the default card.
 * Each describes its own picture, because a page that supplies an og:image
 * overrides the root's but cannot remove sibling tags (see ~/lib/social-card).
 *
 * og:image must be absolute, minted from the canonical origin (never the
 * request origin) and served through our own /img proxy. X reads only
 * twitter:image:alt for its alt text, so the alt is set under both names.
 */
function previewImageMeta(input: {
  shareCardUrl: string | null;
  imageUrl: string | null;
  headline: string;
  publicationName?: string | null;
  ident: string;
}) {
  const { shareCardUrl, imageUrl, headline, publicationName } = input;
  const image = (url: string, alt: string, size?: [number, number]) => [
    { property: "og:image", content: url },
    ...(size
      ? [
          { property: "og:image:width", content: String(size[0]) },
          { property: "og:image:height", content: String(size[1]) },
        ]
      : []),
    { property: "og:image:alt", content: alt },
    { name: "twitter:image:alt", content: alt },
  ];
  if (shareCardUrl)
    return image(
      shareCardUrl,
      // What the card shows: the title, the publication and the byline.
      `"${headline}", ${publicationName ? `in ${publicationName}, ` : ""}by ${input.ident}`,
      [1200, 630],
    );
  // A cover's size isn't in the record, so it goes without one.
  if (imageUrl) return image(imageUrl, `Cover image for "${headline}"`);
  // No picture: the page shows the default card, so it describes it.
  return DEFAULT_CARD_META;
}

/** A record's date field, if it is a string a date parses from. */
function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Whisper-level "Report" link for reading surfaces:
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

/**
 * The reader's edition switch.
 *
 * A reader who wanted to read light on a dark machine, or dark on a light one,
 * had no way to say so from the page they were reading — the preference was
 * always honoured on every route, but the control lived only in our own chrome.
 *
 * ON A THEMED PAGE it does one thing more, and that is the whole design: an
 * explicit choice overrides the author's colours, because following your system
 * is not an opinion about someone else's page but choosing by hand is a
 * statement about how you need to read. Which is why a themed page also offers
 * the way BACK — without "as published", a reader who once tapped dark could
 * never see a writer's colours again, and the override would quietly become the
 * end of theming.
 *
 * Renders nothing until mounted. The label states the edition it switches TO,
 * and getting that from the server would mean guessing the reader's system
 * setting or varying edge-cached HTML per reader — so it waits one paint rather
 * than being wrong or uncacheable.
 */
function ReaderEdition({ themed }: { themed: boolean }) {
  const [edition, setLocal] = useState<Edition | null>(null);
  const [overriding, setOverriding] = useState(false);
  useEffect(() => {
    setLocal(currentEdition());
    setOverriding(document.documentElement.dataset.readerEdition !== undefined);
  }, []);
  if (!edition) return null;
  const next: Edition = edition === "dark" ? "light" : "dark";
  const link =
    "cursor-pointer font-display text-inherit transition-colors hover:text-ink";
  return (
    <>
      <button
        className={link}
        onClick={() => {
          setEdition(next);
          setLocal(next);
          setOverriding(true);
        }}
        type="button"
      >
        Read in {next}
      </button>
      {/* Only where it means something: on a themed page the reader is
          currently overriding the author, and this hands the page back. */}
      {themed && overriding && (
        <>
          {" · "}
          <button
            className={link}
            onClick={() => {
              clearEdition();
              setLocal(currentEdition());
              setOverriding(false);
            }}
            type="button"
          >
            As published
          </button>
        </>
      )}
    </>
  );
}

export function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return utcLongDate(date);
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

/**
 * The provenance line an imported post carries, or null for a native one.
 *
 * Two shapes, because the two imports mean different things (see ~/lib/mirror):
 * a mirror names the host that still holds the original, while a thread
 * self-import names the SHAPE the words first appeared in — the writer isn't
 * pointing readers away, they are showing the piece's own history. Null when
 * there is nothing honest to say, which includes a mirror whose stored URL
 * won't parse: a sentence promising an original and linking nowhere is worse
 * than silence.
 *
 * Exported for tests — it is the whole of this decision in one place.
 */
export function provenanceLine(
  mirror: MirrorInfo | null | undefined,
): { lead: string; label: string; href: string } | null {
  if (!mirror?.sourceUrl) return null;
  if (mirror.kind === "thread")
    return {
      lead: "First published as",
      label: "a thread on Bluesky",
      href: mirror.sourceUrl,
    };
  const host = provenanceHost(mirror.sourceUrl);
  return host
    ? { lead: "Originally published at", label: host, href: mirror.sourceUrl }
    : null;
}

/** Quiet like/reply/repost+quote row — only the reply count is a link, to the
 * bsky.app thread, because the conversation lives on the network. Plain
 * ink-soft icon+number pairs, never a colored badge: this must not read as
 * generic social-media chrome. Renders nothing when no count is worth showing. */
function EngagementRow({ engagement }: { engagement: DocumentEngagement }) {
  const { counts, threadUrl } = engagement;
  if (!hasVisibleEngagement(counts)) return null;
  const reposts = (counts.repostCount ?? 0) + (counts.quoteCount ?? 0);
  const showReposts = isWorthShowing(reposts);
  return (
    <div className="mt-10 flex items-center gap-6 font-display text-sm text-ink-soft">
      {isWorthShowing(counts.likeCount) && (
        <span
          className="inline-flex items-center gap-1.5"
          title={`${counts.likeCount} likes on Bluesky`}
        >
          <HeartIcon className="h-4 w-4" />
          {counts.likeCount}
        </span>
      )}
      {isWorthShowing(counts.replyCount) && (
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
  bodyHtml,
  readingMinutes,
  ident,
  did,
  publicationName,
  publicationDescription,
  publicationIcon,
  publicationAtUri,
  publicationUrl,
  cover,
  mirror,
  relatedPosts,
  engagement,
  conversation,
  theme,
}: {
  doc: StandardDocument;
  ident: string;
  /** The author's DID — who an email left on this page is held for. */
  did?: string | null;
  publicationName?: string | null;
  publicationDescription?: string | null;
  publicationIcon?: CoverRef | null;
  /** The publication record a subscription would point at. Absent on a loose
   * document (an https `site` with no publication record) — there is nothing to
   * subscribe to, and the card simply doesn't offer it. */
  publicationAtUri?: string | null;
  /** The publication record's own url — the ownership signal the email capture
   * gates on, so a publication this instance doesn't host never offers one. */
  publicationUrl?: string | null;
  /** The author's validated theme, or null for our default palette. */
  theme?: BasicTheme | null;
  cover?: CoverRef | null;
  mirror?: MirrorInfo | null;
  relatedPosts?: RelatedPost[];
  /** Streamed, like the conversation: the loader hands both over unawaited
   * (see loadDocument). */
  engagement?: Promise<DocumentEngagement | null>;
  conversation?: Promise<PostConversation | null>;
  /** The body as rendered by the loader (sanitized HTML), with its reading
   * time; the reading time is derived from `doc` when absent. */
  bodyHtml: string;
  readingMinutes?: number;
}) {
  const date = formatDate(doc.publishedAt);
  const updated = formatDate(doc.updatedAt);
  const publicationHref = `/@${encodeURIComponent(ident)}`;
  const provenance = provenanceLine(mirror);
  const readingLabel = formatReadingTime(
    readingMinutes !== undefined
      ? readingMinutes
      : documentReadingMinutes(documentBodyMarkdown(doc)),
  );
  // The dek is ALWAYS shown when set — not just as a no-body fallback — as its
  // own line under the H1.
  const dek = doc.description?.trim() || null;
  // The year of the piece, not of the render — a 2024 essay should not claim
  // 2026 because someone opened it today.
  const copyrightYear = new Date(
    doc.publishedAt ?? Date.now(),
  ).getUTCFullYear();

  return (
    // The writer's surface, not ours: their theme applies here, our dark-mode
    // toggle deliberately does not (see WriterSurface and styles.css).
    <WriterSurface theme={theme}>
      {/* The post is this page's main content: <main> makes it the landmark
          assistive tech jumps to and carries the skip link's target, and
          <article> says what it is. */}
      <main
        className="mx-auto max-w-[42rem] px-6 py-16 md:py-24"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
        <article>
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
          {/* THE FLAG — the writer's masthead, above their own headline.
            This page is where every timeline card lands, so "whose page is
            this" has to be answered before the title, not footnoted under it.
            The archive page already sets the publication name like a masthead;
            the article page used to give the same identity a 24px icon and a
            grey line of small text. The calm register says the platform
            disappears and the WRITER'S identity dominates — this is the second
            half of that sentence, finally executed. */}
          {(publicationName || publicationIcon) && (
            <div className="mb-12 border-b border-rule pb-4">
              <a
                className="inline-flex items-center gap-2.5 transition-colors hover:text-ink"
                href={publicationHref}
              >
                {publicationIcon && (
                  <img
                    alt=""
                    className="h-7 w-7 shrink-0 object-cover"
                    src={blobImagePath(
                      publicationIcon.did,
                      publicationIcon.cid,
                    )}
                  />
                )}
                <span className="font-display text-[0.85rem] font-semibold tracking-[0.14em] text-ink uppercase">
                  {publicationName ?? `@${ident}`}
                </span>
              </a>
            </div>
          )}
          <header className="mb-10 border-b border-rule pb-8">
            {/* THE HEADER IS FURNITURE; THE PIECE IS PROSE. Two faces, and the
              line between them is the point.

              Everything here used to be one serif — title, dek and body — so
              the header never separated from the reading matter and the dek
              read as a greyed-out paragraph rather than as a standfirst. The
              pairing that fixes it is the one the design system already
              specifies: display face for mastheads, headings and labels, body
              serif for prose. The title is a heading. It belongs in display.

              The scale is stated as ratios against the 17px body, because
              "proportional to the main text" is the actual requirement and
              absolute pixels hide it:
                title   2rem      ≈ 1.88× body
                dek     0.9375rem ≈ 0.88× body
                byline  0.875rem  ≈ 0.82× body
              Still a monotonic descent — 32 / 15 / 14 — with the dek now just
              under the body rather than just over it. Below body size it can
              only read as a standfirst if the FACE distinguishes it, which is
              the display/serif pairing's other job.

              Negative tracking because display bold at 32px sets loose,
              especially in the all-caps titles older texts carry. Well inside
              the -0.04em floor. */}
            <h1 className="font-display text-[2rem] leading-[1.15] font-bold tracking-[-0.02em] text-balance text-ink">
              {doc.title ?? "Untitled"}
            </h1>
            {/* The dek belongs to the header block, not to the prose, so it
              takes the header's face. An earlier pass set it in the body serif
              on the argument that it is the writer's own sentence — true, but
              it made the dek indistinguishable from the first paragraph, which
              is worse: on a post whose opening line IS the description, the two
              read as the same text printed twice.

              Roman, not italic — italic had become a default soft voice across
              the product rather than an emphasis, which costs it all meaning.
              Softer ink and the smaller size carry the subordination.

              Full column width, no measure cap. It had one, on the reasoning
              that a standfirst wants a shorter line — but the title and the
              rule beneath both run the full column, so a dek stopping short of
              them read as a mistake rather than as a choice. The column is
              already the measure; capping inside it just breaks the left-edge
              alignment the header depends on. */}
            {dek && (
              <p className="mt-4 font-display text-[0.9375rem] leading-[1.55] text-ink-soft">
                {dek}
              </p>
            )}
            {/* The byline, split in two. Five facts used to share one whisper —
              the person's name deserves its own line at ink weight; the
              circumstances of publication belong beneath it, softer. */}
            <div className="mt-6 font-display text-sm">
              <p>
                <a
                  className="font-semibold text-ink transition-colors hover:text-ink-soft"
                  href={publicationHref}
                >
                  @{ident}
                </a>
              </p>
              <p className="mt-1 text-ink-soft">
                {date && <time dateTime={doc.publishedAt}>{date}</time>}
                {readingLabel && (
                  <>
                    {date && " · "}
                    {readingLabel}
                  </>
                )}
                {updated && updated !== date && <> · updated {updated}</>}
              </p>
            </div>
            {/* Provenance for imported posts (import ledger). Two sentences, not
                one, because they say different things: a mirror admits the
                original lives elsewhere (the honest half of "keep your
                Substack"), while a thread self-import names the shape the piece
                first appeared in — the writer isn't deferring to anyone, they
                are showing their work. Calm register, no ornament. */}
            {provenance && (
              <p className="mt-2 font-display text-sm text-ink-soft">
                {provenance.lead}{" "}
                <ExternalLink
                  className="underline underline-offset-2 transition-colors hover:text-ink"
                  href={provenance.href}
                >
                  {provenance.label}
                </ExternalLink>
              </p>
            )}
          </header>
          {bodyHtml !== "" ? (
            <Prose html={bodyHtml} />
          ) : (
            <p className="font-display text-sm text-ink-soft">
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
          {/* THE COLOPHON — the signature moment, placed where goodwill is
            highest: directly after the last line of the piece, before the
            letters. A magazine's contributor note, not a leftover grey box.
            This is the reading surface's ONE capture moment and it belongs to
            the writer, not to us; the email field lands here and nowhere else on
            a post. No sticky bar, no modal, no second ask. */}
          <aside className="mt-14 border-t border-ink pt-8">
            <div className="flex items-start gap-4">
              {publicationIcon && (
                <img
                  alt=""
                  className="h-10 w-10 shrink-0 object-cover"
                  src={blobImagePath(publicationIcon.did, publicationIcon.cid)}
                />
              )}
              <div className="min-w-0">
                <p className="font-display text-lg leading-tight font-bold text-ink">
                  {publicationName ?? `@${ident}`}
                </p>
                {publicationDescription && (
                  <p className="mt-2 text-base leading-relaxed text-ink-soft">
                    {publicationDescription}
                  </p>
                )}
                {/* Subscribing leads, because it is the only one of the three
                  that happens HERE — the other two hand the reader to Bluesky
                  or to their feed reader. Still ink and still quiet: this
                  card is the writer's capture moment, not ours. */}
                <SubscribeControl
                  className="mt-5"
                  publicationAtUri={publicationAtUri ?? null}
                />
                {/* The email, under the network relationship rather than over it:
                  subscribing works today and sending does not, so the thing that
                  works leads. Renders nothing at all for a publication this
                  instance doesn't host. */}
                <ReaderEmailCapture
                  className="mt-6"
                  ident={ident}
                  publicationName={publicationName}
                  publicationUrl={publicationUrl}
                  source="post"
                  writerDid={did}
                />
                <p className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 font-display text-sm">
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
            </div>
          </aside>
          {/* Engagement row: announced posts only, and only when the AppView
            returned a count worth showing — silence, never a placeholder or a
            false zero. Streamed, so it sits with the replies rather than
            above the colophon: arriving late here moves only what the replies
            already move, never the article or the subscribe card under it.
            Without JavaScript the streamed part never swaps in, and the page
            simply has no counts. */}
          {engagement && (
            <Suspense fallback={null}>
              <Await promise={engagement}>
                {(found) => found && <EngagementRow engagement={found} />}
              </Await>
            </Suspense>
          )}
          {/* The conversation that already exists on the network. Announced
            posts with at least one readable reply only — a post nobody has
            replied to (or that was never announced) renders nothing here, and
            so does an AppView that was down. No empty state to design. */}
          {conversation && (
            <Suspense fallback={null}>
              <Await promise={conversation}>
                {(replies) =>
                  replies && <Conversation conversation={replies} />
                }
              </Await>
            </Suspense>
          )}
          <aside className="mt-16 border-t border-rule pt-10">
            {relatedPosts && relatedPosts.length > 0 && (
              <div className="mt-10">
                <p className="font-display text-xs font-semibold tracking-wide text-ink-soft uppercase">
                  More from {publicationName ?? `@${ident}`}
                </p>
                <ul>
                  {relatedPosts.map((post) => {
                    const postDate = formatDate(post.publishedAt ?? undefined);
                    return (
                      <li
                        className="border-t border-rule py-4 first:border-t-0"
                        key={post.rkey}
                      >
                        <a
                          className="leading-snug font-semibold text-ink hover:underline hover:underline-offset-4"
                          href={`${publicationHref}/${encodeURIComponent(post.rkey)}`}
                        >
                          {post.title}
                        </a>
                        {postDate && (
                          <p className="mt-1 font-display text-xs tracking-wide text-ink-soft uppercase">
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
          {/* The close, in two voices — the printed-book settlement between the
            two-surface rule and the need to be findable. The writer's fact
            leads; Goldroad gets exactly one line, last, at printer's-mark
            volume. Never a band, never a badge. The line is also the only
            surface a reader who might become a writer ever meets us on, so it
            points at /open rather than at a pitch. */}
          <footer className="mt-10 border-t border-rule pt-6">
            {/* Deliberately NOT a copyright notice.
              Copyright is automatic under Berne — a notice grants nothing, and
              "All rights reserved" has been legally inert since the last Buenos
              Aires signatory joined Berne in 2000. Worse, it would be a claim
              made on the writer's behalf that we have no way to know is true:
              a writer who licensed this piece CC-BY would find us stamping
              "all rights reserved" on it. Their byline above already carries
              the attribution, which is the part that does real work.
              When writers can declare a licence, this line shows THEIR choice. */}
            <p className="font-display text-xs text-ink-soft/80">
              {copyrightYear} · {publicationName ?? `@${ident}`}
            </p>
            <p className="mt-1 font-display text-xs text-ink-soft/80">
              <a
                className="transition-colors hover:text-ink"
                href={`${CANONICAL_ORIGIN}/open`}
              >
                Goldroad — open-source, writer-owned publishing
              </a>{" "}
              · <ReportLink />
              {/* Only when the author set no theme. An unthemed page follows the
                READER's edition, so the control belongs where the preference
                actually applies — and on a themed page there would be nothing
                for it to change, because the author's colours are the answer.
                Down here rather than in the header: the platform disappears on
                a writer's surface, so our one control keeps our one line's
                volume instead of putting a widget above their masthead. */}
              {" · "}
              <ReaderEdition themed={Boolean(theme)} />
            </p>
          </footer>
        </article>
      </main>
    </WriterSurface>
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
        <p className="font-display text-sm font-semibold text-ink-soft">
          Nothing at this address
        </p>
        <h1 className="mt-3 text-3xl leading-[1.15] font-semibold text-balance">
          This page isn't published.
        </h1>
        <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-ink-soft">
          The handle may be misspelled, or the writer may have taken this post
          down — their archive, their call.
        </p>
        <p className="mt-8 font-display text-sm text-ink-soft">
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
 * Takedown state: the author or record is on the
 * hide-list, so we don't serve it. Calm register, honest and non-accusatory —
 * we don't reveal who reported it or why. Rendered with a 451 status.
 */
export function ContentUnavailable() {
  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-24">
        <p className="font-display text-sm font-semibold text-ink-soft">
          Unavailable
        </p>
        <h1 className="mt-3 text-3xl leading-[1.15] font-semibold text-balance">
          This content is unavailable.
        </h1>
        <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-ink-soft">
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
        <p className="mt-8 font-display text-sm text-ink-soft">
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
