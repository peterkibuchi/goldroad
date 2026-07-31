import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import {
  isDid,
  isHandle,
  listRecords,
  listRecordsPage,
  NotFoundError,
  resolveDidToPds,
  resolveHandleToDid,
  rkeyFromUri,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import {
  type FeedItem,
  plainTextExcerpt,
  RSS_CONTENT_TYPE,
  rfc822Date,
  rssFeedXml,
} from "~/lib/feed";
import { markdownToHtml } from "~/lib/markdown-html";
import { hiddenSubjects, recordAtUri } from "~/lib/moderation";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { composeDocumentUrl } from "~/lib/publish";
import { env } from "cloudflare:workers";

/**
 * Per-publication RSS 2.0 feed — the machine-readable twin of the publication
 * page (routes/@{$handle}.index.tsx): same record loading, same takedown
 * policy, one newest-first PDS page of documents. Works for any atproto
 * author, not just Goldroad writers.
 *
 * Every interpolated value is third-party-authored (records read from
 * arbitrary PDSes) — rssFeedXml escapes all of it (see ~/lib/feed).
 *
 * Caching: the path lives under /@…, so the edge read cache
 * (~/lib/read-cache) already matches the request; its response guard
 * explicitly allows this content type. 404s never cache, mirroring the pages.
 *
 * There is deliberately NO /p/… feed: the v0 era only ever had document URLs
 * (no publication index), so this is the one feed surface per author.
 *
 * Known shadow: this static segment outranks /@{$handle}/$rkey, so a document
 * whose rkey is literally "rss.xml" is unreachable at that address. Accepted:
 * our records are TID-keyed (no dot), only a hand-crafted foreign rkey could
 * collide, and such a document stays reachable via /p/….
 */

/** Feeds mirror the reader pages: every rejection is a plain 404. Negative
 * results stay uncached so a takedown lift or PDS flake recovers immediately
 * (the read cache only stores 200s anyway; no-store covers browsers too). */
const NOT_FOUND = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });

export const Route = createFileRoute("/@{$handle}/rss.xml")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // A lone "%" in the path throws URIError — a malformed address is a
        // 404, never a 5xx (same invariant as the reader pages).
        let ident: string;
        try {
          ident = decodeURIComponent(params.handle);
        } catch {
          return NOT_FOUND();
        }
        if (!isHandle(ident) && !isDid(ident)) return NOT_FOUND();
        try {
          const did = isDid(ident) ? ident : await resolveHandleToDid(ident);
          const pds = await resolveDidToPds(did);
          const [pubs, docsPage] = await Promise.all([
            // Oldest publication = the author's original one (page parity).
            listRecords<StandardPublication>(
              pds,
              did,
              "site.standard.publication",
              { limit: 10, reverse: true },
            ).catch(() => []),
            listRecordsPage<StandardDocument>(
              pds,
              did,
              "site.standard.document",
              {},
            ).catch(() => ({ records: [], cursor: null })),
          ]);
          const publication = pubs[0]?.value ?? null;
          // Documents may reference ANY of the author's publications (site =
          // at:// URI); the fetched page already holds them, so composition
          // resolves against all of them, not just the oldest.
          const pubUrlByAtUri = new Map(
            pubs.flatMap((p) =>
              typeof p.value.url === "string"
                ? [[p.uri, p.value.url] as const]
                : [],
            ),
          );

          // Mint each document's AT-URI from the validated DID + rkey — never
          // from the PDS-reported uri, which a hostile PDS could skew so a
          // record-level takedown row (keyed on the minted shape, see
          // recordAtUri) would fail to match. The same minted URI is the guid.
          const entries = docsPage.records.flatMap((r) => {
            const rkey = rkeyFromUri(r.uri);
            if (!rkey || typeof r.value.title !== "string") return [];
            return [
              {
                rkey,
                atUri: recordAtUri(did, "site.standard.document", rkey),
                value: r.value,
              },
            ];
          });

          // Takedown policy in one indexed IN() query: a hidden AUTHOR turns
          // the whole feed into the same 404 the publication page serves; a
          // hidden RECORD is excluded while the rest keeps flowing. Server
          // route handlers hold the D1 binding directly (the /img pattern);
          // env.DB is absent in unit tests, and a D1 error fails open —
          // availability over enforcement, the same accepted tradeoff as the
          // reader pages' checkHidden (the check re-runs once the short edge
          // cache expires).
          const hidden = env.DB
            ? await hiddenSubjects(drizzle(env.DB), [
                did,
                ...entries.map((e) => e.atUri),
              ]).catch(() => new Set<string>())
            : new Set<string>();
          if (hidden.has(did)) return NOT_FOUND();

          const items: FeedItem[] = entries
            .filter((e) => !hidden.has(e.atUri))
            .sort(
              (a, b) =>
                Date.parse(b.value.publishedAt ?? "") -
                  Date.parse(a.value.publishedAt ?? "") ||
                (a.rkey < b.rkey ? 1 : -1),
            )
            .map((e) => {
              const doc = e.value;
              // Canonical composed URL (publication.url + document.path —
              // page parity); when composition fails (foreign publication
              // ref, missing path) fall back to our own reading surface,
              // which renders any author's document.
              const link =
                composeDocumentUrl({
                  site: doc.site,
                  path: doc.path,
                  publicationUrl:
                    typeof doc.site === "string"
                      ? pubUrlByAtUri.get(doc.site)
                      : undefined,
                }) ??
                `${CANONICAL_ORIGIN}/@${encodeURIComponent(ident)}/${encodeURIComponent(e.rkey)}`;
              return {
                title: doc.title ?? "Untitled",
                link,
                guid: e.atUri,
                pubDate: rfc822Date(doc.publishedAt),
                description:
                  typeof doc.description === "string" &&
                  doc.description.trim() !== ""
                    ? doc.description
                    : typeof doc.textContent === "string"
                      ? plainTextExcerpt(doc.textContent)
                      : null,
                // The full post, rendered the same way the page renders it.
                // The text is already here — the record carries it — so an
                // excerpt-only feed was withholding something it had, and a
                // reader in a feed reader got less of the piece than a reader
                // on the page.
                content: markdownToHtml(doc.textContent),
              };
            });

          // Channel URLs are minted from the canonical origin, never the
          // request origin — permanent references must not depend on
          // infrastructure hostnames (see ~/lib/origin).
          const pageUrl = `${CANONICAL_ORIGIN}/@${encodeURIComponent(ident)}`;
          const xml = rssFeedXml(
            {
              title:
                typeof publication?.name === "string" &&
                publication.name.trim() !== ""
                  ? publication.name
                  : ident,
              link: pageUrl,
              selfUrl: `${pageUrl}/rss.xml`,
              description:
                typeof publication?.description === "string" &&
                publication.description.trim() !== ""
                  ? publication.description
                  : `Writing by @${ident}`,
            },
            items,
          );
          return new Response(xml, {
            headers: {
              "content-type": RSS_CONTENT_TYPE,
              "x-content-type-options": "nosniff",
            },
          });
        } catch (err) {
          if (err instanceof NotFoundError) return NOT_FOUND();
          throw err;
        }
      },
    },
  },
});
