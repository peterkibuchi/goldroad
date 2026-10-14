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
import { documentBodyMarkdown } from "~/lib/document-content";
import {
  type FeedItem,
  plainTextExcerpt,
  RSS_CONTENT_TYPE,
  rfc822Date,
  rssFeedXml,
} from "~/lib/feed";
import { formerHandleRedirect, formerHandleTarget } from "~/lib/handle-history";
import { renderBodies, renderBudget } from "~/lib/markdown-html";
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

/** Items per feed. Each can cost a render-cache lookup and a store, and those
 * share the free plan's 50-subrequest budget with the PDS and directory reads
 * (at most 2 × 20 + 6 on a cold request). */
const FEED_ITEMS = 20;

/** Characters of HTML one feed carries in `content:encoded`, about 2 to 4 ms
 * of escaping. Under feed.ts's per-item cap, so no post is ever cut short. */
const FEED_CONTENT_BUDGET_CHARS = 150_000;

const UNAVAILABLE = () =>
  new Response("This feed couldn't be loaded right now. Try again shortly.", {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "300" },
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
        let did: string;
        try {
          did = isDid(ident) ? ident : await resolveHandleToDid(ident);
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          // Perhaps a feed URL from before the writer changed handle.
          const target = env.DB
            ? await formerHandleTarget(drizzle(env.DB), ident).catch(() => null)
            : null;
          if (!target) return NOT_FOUND();
          const { href, statusCode, headers } = formerHandleRedirect(
            target,
            "/rss.xml",
          );
          return new Response(null, {
            status: statusCode,
            headers: { ...headers, location: href },
          });
        }
        try {
          const pds = await resolveDidToPds(did);
          const [pubs, docsPage] = await Promise.all([
            // Oldest publication = the author's original one (page parity).
            listRecords<StandardPublication>(
              pds,
              did,
              "site.standard.publication",
              { limit: 10, reverse: true },
            ).catch((err: unknown) =>
              err instanceof NotFoundError ? [] : null,
            ),
            listRecordsPage<StandardDocument>(
              pds,
              did,
              "site.standard.document",
              { limit: FEED_ITEMS },
            ).catch((err: unknown) =>
              // A refused listing is an empty feed; a failed one (too large,
              // unreachable) is a 503, so readers keep the items they have
              // and retry, instead of being told every post is gone.
              err instanceof NotFoundError
                ? { records: [], cursor: null }
                : null,
            ),
          ]);
          const publication = pubs?.[0]?.value ?? null;
          // Documents may reference ANY of the author's publications (site =
          // at:// URI); the fetched page already holds them, so composition
          // resolves against all of them, not just the oldest.
          const pubUrlByAtUri = new Map(
            (pubs ?? []).flatMap((p) =>
              typeof p.value.url === "string"
                ? [[p.uri, p.value.url] as const]
                : [],
            ),
          );

          // Mint each document's AT-URI from the validated DID + rkey — never
          // from the PDS-reported uri, which a hostile PDS could skew so a
          // record-level takedown row (keyed on the minted shape, see
          // recordAtUri) would fail to match. The same minted URI is the guid.
          const entries = (docsPage?.records ?? []).flatMap((r) => {
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
          if (docsPage === null) return UNAVAILABLE();

          const visible = entries
            .filter((e) => !hidden.has(e.atUri))
            .sort(
              (a, b) =>
                Date.parse(b.value.publishedAt ?? "") -
                  Date.parse(a.value.publishedAt ?? "") ||
                (a.rkey < b.rkey ? 1 : -1),
            );
          // The same bodies the page renders, through the same cache. Misses
          // render newest-first under one budget, so on a cold cache the
          // items a reader sees first are the ones with full text.
          const bodies = visible.map((e) => documentBodyMarkdown(e.value));
          const html = await renderBodies(bodies, renderBudget());
          // Escaping the HTML into XML costs CPU even on a cache hit, so the
          // feed's total full text is bounded too; past it, the excerpt.
          let contentLeft = FEED_CONTENT_BUDGET_CHARS;
          const items: FeedItem[] = visible.map((e, i) => {
            const doc = e.value;
            const body = bodies[i];
            const fits = html[i].length <= contentLeft;
            if (fits) contentLeft -= html[i].length;
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
                  : body
                    ? plainTextExcerpt(body)
                    : null,
              // "" (over a budget) leaves only `description`.
              content: fits ? html[i] : "",
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
              // Titled from a failed publication read: don't cache that.
              ...(pubs === null ? { "cache-control": "no-store" } : {}),
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
