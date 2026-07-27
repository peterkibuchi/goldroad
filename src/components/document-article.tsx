import { notFound, useLocation } from "@tanstack/react-router";

import { ExternalLink } from "~/components/external-link";
import { Prose } from "~/components/prose";
import {
  getRecordEntry,
  isDid,
  isHandle,
  NotFoundError,
  parseAtUri,
  RKEY_RE,
  resolveDidToPds,
  resolveHandleToDid,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import { checkMirror, type MirrorInfo } from "~/lib/mirror";
import { checkHidden, recordAtUri } from "~/lib/moderation";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { composeDocumentUrl } from "~/lib/publish";

/** A validated cover image reference, serveable through /img/$did/$cid. */
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

    // Resolve the document's publication (same-repo at:// site refs only) for
    // the standard.site canonical URL (publication.url + document.path) and
    // the byline's publication name.
    let publicationUrl: string | undefined;
    let publicationName: string | null = null;
    const siteRef = typeof doc.site === "string" ? parseAtUri(doc.site) : null;
    if (
      siteRef &&
      siteRef.did === did &&
      siteRef.collection === "site.standard.publication"
    ) {
      const pub = await getRecordEntry<StandardPublication>(
        pds,
        siteRef.did,
        siteRef.collection,
        siteRef.rkey,
      ).catch(() => null);
      if (typeof pub?.value.url === "string") publicationUrl = pub.value.url;
      if (typeof pub?.value.name === "string" && pub.value.name.trim() !== "")
        publicationName = pub.value.name;
    }

    // Mirror lookup (import ledger): a hit swaps the canonical tag for
    // noindex and adds the "Originally published at …" line below. Null =
    // native post, adopted mirror, or a flaked read (fail open).
    const mirror = await checkMirror({ data: { did, rkey } });

    const coverCid = coverImageCid(doc.coverImage);
    return {
      doc,
      ident,
      publicationName,
      mirror,
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
      }
    | undefined,
) {
  if (!loaderData) return { meta: [{ title: "Not found" }] };
  const { doc, ident, atUri, canonicalUrl, cover, mirror } = loaderData;
  const title = `${doc.title ?? "Untitled"} — ${ident}`;
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
      ...(cover
        ? [
            {
              property: "og:image",
              content: `${CANONICAL_ORIGIN}${blobImagePath(cover.did, cover.cid)}`,
            },
          ]
        : []),
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

export function DocumentArticle({
  doc,
  ident,
  publicationName,
  cover,
  mirror,
}: {
  doc: StandardDocument;
  ident: string;
  publicationName?: string | null;
  cover?: CoverRef | null;
  mirror?: MirrorInfo | null;
}) {
  const body = doc.textContent ?? "";
  const date = formatDate(doc.publishedAt);
  const updated = formatDate(doc.updatedAt);
  const publicationHref = `/@${encodeURIComponent(ident)}`;
  const mirrorHost = mirror ? provenanceHost(mirror.sourceUrl) : null;

  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <article className="mx-auto max-w-[42rem] px-6 py-16 md:py-24">
        {cover && (
          // Decorative on the page (the adjacent title names the piece);
          // calm register — no border ornament, the image speaks alone.
          <img
            alt=""
            className="mb-10 w-full"
            src={blobImagePath(cover.did, cover.cid)}
          />
        )}
        <header className="mb-10 border-rule border-b pb-8">
          {publicationName && (
            <p className="mb-6 font-display font-semibold text-ink-soft text-sm">
              <a
                className="transition-colors hover:text-ink"
                href={publicationHref}
              >
                {publicationName}
              </a>
            </p>
          )}
          <h1 className="text-balance font-semibold text-3xl text-ink leading-[1.15] md:text-4xl">
            {doc.title ?? "Untitled"}
          </h1>
          <p className="mt-4 font-display text-ink-soft text-sm">
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
            {updated && updated !== date && <span> · updated {updated}</span>}
          </p>
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
        {body.trim() !== "" ? (
          <Prose markdown={body} />
        ) : doc.description ? (
          <p className="text-ink-soft text-lg italic leading-relaxed">
            {doc.description}
          </p>
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
        <footer className="mt-16 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-rule border-t pt-6">
          <p className="font-display text-ink-soft text-xs">
            <a
              className="underline underline-offset-2 transition-colors hover:text-ink"
              href={publicationHref}
            >
              More from {publicationName ?? `@${ident}`}
            </a>
          </p>
          {/* Whisper-level platform credit (two-surface rule: the writer owns
              this page; Goldroad stays out of the way). */}
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
