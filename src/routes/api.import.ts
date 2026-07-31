/**
 * Feed-import API (one-time RSS import → drafts), step 1 of 2: the writer
 * pastes a URL, this handler fetches and parses the feed, and answers with
 * the picker's item list — titles, dates, flags, and each item's HTML.
 *
 * The HTML comes back WITH the list (not via per-item re-fetches): the feed
 * body already carried it, the whole response is bounded by the feed's own
 * 2 MB stream cap, and the browser does the HTML→blocks conversion — the
 * worker never converts and never stores raw HTML. Conversion doubles as
 * sanitization downstream: BlockNote's parser structurally drops
 * script/iframe/unknown nodes, and the reader renders markdown with raw HTML
 * inert, so no server-side sanitizer exists to drift.
 *
 * Trust posture, in order:
 *  1. Session cookie → DID; no session, no API (the abuser is authenticated).
 *  2. Same-origin check on POST (defense in depth beside SameSite=Lax).
 *  3. Rate limit: MAX_IMPORTS_PER_HOUR feed fetches per DID, counted in D1.
 *  4. The URL (and every redirect hop, and every autodiscovery candidate) is
 *     SSRF-validated; bodies are stream-capped (see ~/lib/import).
 *
 * Moderation note: no hide-list check happens at import time — imports land
 * as PRIVATE drafts. Publishing a mirror produces an ordinary record, and the
 * existing hidden_content levers apply to it unchanged.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { isDid } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { countDrafts } from "~/lib/drafts";
import { MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import {
  discoverFeedUrls,
  fetchImportable,
  guidHash,
  ImportError,
  looksLikeHtml,
  MAX_IMPORT_URL_LENGTH,
  MAX_IMPORTS_PER_HOUR,
  type ParsedFeed,
  parseFeedDocument,
  readFeedBody,
} from "~/lib/import";
import { computeImportedSet } from "~/lib/import-flags";
import {
  countRecentImportFetches,
  insertImportFetch,
  pruneImportFetches,
} from "~/lib/import-store";
import { readLiveSessionDid } from "~/lib/live-session";
import { isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import { env } from "cloudflare:workers";

const importPayload = z.object({
  url: z.string().min(1).max(MAX_IMPORT_URL_LENGTH),
});

const RATE_WINDOW_MS = 60 * 60 * 1000;

/** ImportError → an HTTP status + a plain reason the page can show. */
function importErrorResponse(err: ImportError): Response {
  switch (err.code) {
    case "invalid_url":
    case "own_host":
      return privateJson({ ok: false, error: "invalid_url" }, 400);
    case "feed_too_large":
      return privateJson({ ok: false, error: "feed_too_large" }, 413);
    case "upstream_blocked":
      return privateJson({ ok: false, error: "upstream_blocked" }, 502);
    case "too_many_redirects":
    case "fetch_failed":
      return privateJson({ ok: false, error: "fetch_failed" }, 502);
    default:
      return privateJson({ ok: false, error: "not_a_feed" }, 422);
  }
}

/**
 * Fetch the URL as a feed; when it answers with HTML, walk the autodiscovery
 * candidates (link rel=alternate hints, then /feed and /rss/). Returns the
 * parsed feed + the URL that actually was one.
 */
async function resolveFeed(
  urlString: string,
): Promise<{ feed: ParsedFeed; feedUrl: string }> {
  const { res, finalUrl } = await fetchImportable(urlString);
  // 429 = the host is refusing us specifically (Substack does, for all
  // Workers egress) — a retry can't fix it, so it gets its own code and the
  // page points at the export upload instead.
  if (res.status === 429) throw new ImportError("upstream_blocked");
  if (!res.ok) throw new ImportError("fetch_failed");
  const body = await readFeedBody(res);
  const feed = parseFeedDocument(body);
  if (feed) return { feed, feedUrl: finalUrl.href };

  if (looksLikeHtml(body)) {
    for (const candidate of discoverFeedUrls(body, finalUrl)) {
      try {
        const next = await fetchImportable(candidate);
        if (!next.res.ok) continue;
        const nextBody = await readFeedBody(next.res);
        const nextFeed = parseFeedDocument(nextBody);
        if (nextFeed) return { feed: nextFeed, feedUrl: next.finalUrl.href };
      } catch {
        // one candidate failing is not the run failing — try the next
      }
    }
  }
  throw new ImportError("not_a_feed");
}

export const Route = createFileRoute("/api/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return privateJson({ ok: false, error: "cross_site" }, 403);
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did))
          return privateJson({ ok: false, error: "not_signed_in" }, 401);

        // The payload is one short URL — cap the body well below any parse.
        const raw = await readBodyCapped(request, 8 * 1024);
        if (raw === null)
          return privateJson({ ok: false, error: "too_large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return privateJson({ ok: false, error: "invalid" }, 400);
        }
        const parsed = importPayload.safeParse(body);
        if (!parsed.success)
          return privateJson({ ok: false, error: "invalid" }, 400);

        const db = drizzle(env.DB);
        const now = Date.now();
        const windowStart = new Date(now - RATE_WINDOW_MS);
        // Prune-then-count keeps the table tiny without a cron; the insert
        // records this run BEFORE the fetch (a failed fetch still spent it).
        await pruneImportFetches(db, windowStart);
        const [{ n }] = await countRecentImportFetches(db, did, windowStart);
        if (n >= MAX_IMPORTS_PER_HOUR) {
          return privateJson({ ok: false, error: "rate_limited" }, 429);
        }
        await insertImportFetch(db, did);

        let resolved: Awaited<ReturnType<typeof resolveFeed>>;
        try {
          resolved = await resolveFeed(parsed.data.url);
        } catch (err) {
          if (err instanceof ImportError) return importErrorResponse(err);
          console.error("feed import failed", err);
          return privateJson({ ok: false, error: "fetch_failed" }, 502);
        }

        // Already-imported flags: hash every item's guid, then the shared
        // ledger rule (~/lib/import-flags — published or still-live-draft
        // counts; a discarded draft's row does not).
        const { feed, feedUrl } = resolved;
        const hashes = await Promise.all(
          feed.items.map((item) => guidHash(item.guid)),
        );
        const imported =
          hashes.length > 0
            ? await computeImportedSet(db, did, hashes)
            : new Set<string>();

        const [{ n: draftCount }] = await countDrafts(db, did);
        return privateJson({
          ok: true,
          feed: { title: feed.title, url: feedUrl },
          totalItems: feed.totalItems,
          draftSlotsRemaining: Math.max(0, MAX_DRAFTS_PER_USER - draftCount),
          items: feed.items.map((item, i) => ({
            guid: item.guid,
            guidHash: hashes[i],
            link: item.link,
            title: item.title,
            publishedAt: item.publishedAt,
            contentHtml: item.contentHtml,
            preview: item.preview,
            alreadyImported: imported.has(hashes[i]),
          })),
        });
      },
    },
  },
});
