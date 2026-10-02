/**
 * Thread-import API, step 1 of 3: list the writer's OWN Bluesky threads.
 *
 * Reads the public AppView unauthenticated (~/lib/threads) for the SESSION's
 * DID and nothing else — the actor is never taken from the request, so this
 * endpoint cannot be pointed at a stranger's account to enumerate their posts
 * on our egress. That is the whole authorization model: what you can list is
 * who you are signed in as.
 *
 * Trust posture, in the same order /api/import states it:
 *  1. Session cookie → DID; no session, no API (the abuser is authenticated).
 *  2. Same-origin check on POST (defense in depth beside SameSite=Lax).
 *  3. Rate limit: MAX_THREAD_FETCHES_PER_HOUR runs per DID, counted in D1
 *     under the `thread` kind so it holds its own budget (see ~/db/schema).
 *  4. The AppView host is a fixed constant, every response is stream-capped
 *     and timeout-bounded, and every field is read defensively.
 *
 * Cached at the edge for a minute: a writer opening the picker, going back for
 * the draft count and returning should not spend a second page-walk, and a
 * minute is short enough that a thread posted just now still shows up. The
 * cache key is the DID — this is the writer's own list, so it is keyed to them
 * and served from a synthetic internal host, never a routable one.
 *
 * Moderation note, same as /api/import: no hide-list check happens here.
 * Imports land as PRIVATE drafts; publishing produces an ordinary record and
 * the existing hidden_content levers apply to it unchanged.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { isDid } from "~/lib/atproto";
import { countDrafts } from "~/lib/drafts";
import { MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import { guidHash } from "~/lib/import";
import { computeImportedSet } from "~/lib/import-flags";
import {
  countRecentImportFetches,
  insertImportFetch,
  pruneImportFetches,
} from "~/lib/import-store";
import { readLiveSessionDid } from "~/lib/live-session";
import { isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import {
  discoverAuthorThreads,
  MAX_THREAD_FETCHES_PER_HOUR,
  THREAD_DISCOVERY_CACHE_TTL_SECONDS,
} from "~/lib/threads";
import { defaultCache } from "~/lib/workers-cache";
import { env } from "cloudflare:workers";

/** Matches /api/import's window, which is also what lets the two kinds share
 * one inline prune: both are pruned at the same one-hour boundary. */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Synthetic, cacheable-key URL for one writer's thread list. The DID is the
 * whole key — nothing else about the request varies the answer. Never routable,
 * same construction as ~/lib/comments' conversationCacheUrl. */
function discoveryCacheUrl(did: string): string {
  return `https://goldroad-threads.internal/v1/${encodeURIComponent(did)}`;
}

type DiscoveredThreads = Awaited<ReturnType<typeof discoverAuthorThreads>>;

/** Cache read. A miss, a malformed entry and no cache at all are one answer:
 * null, meaning "go and read the AppView". */
async function readCached(
  cache: Cache,
  did: string,
): Promise<DiscoveredThreads | null> {
  const hit = await cache.match(discoveryCacheUrl(did)).catch(() => undefined);
  if (!hit) return null;
  const cached = (await hit.json().catch(() => null)) as DiscoveredThreads;
  return cached && Array.isArray(cached.threads) ? cached : null;
}

export const Route = createFileRoute("/api/threads")({
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

        // No payload at all: the only input this endpoint has is the session,
        // so there is nothing to parse and nothing to validate. A body, if one
        // is sent, is ignored rather than read.
        const db = drizzle(env.DB);
        const cache = defaultCache();
        let discovered = cache ? await readCached(cache, did) : null;

        if (!discovered) {
          const windowStart = new Date(Date.now() - RATE_WINDOW_MS);
          // Prune-then-count, then record the run BEFORE the fetch — a failed
          // page-walk still spent the attempt. Same shape as /api/import.
          await pruneImportFetches(db, windowStart);
          const [{ n }] = await countRecentImportFetches(
            db,
            did,
            windowStart,
            "thread",
          );
          if (n >= MAX_THREAD_FETCHES_PER_HOUR)
            return privateJson({ ok: false, error: "rate_limited" }, 429);
          await insertImportFetch(db, did, "thread");

          discovered = await discoverAuthorThreads(did);
          if (!discovered || discovered.unavailable)
            return privateJson({ ok: false, error: "appview_failed" }, 502);
          if (cache) {
            const body = new Response(JSON.stringify(discovered), {
              headers: {
                "content-type": "application/json",
                "cache-control": `public, s-maxage=${THREAD_DISCOVERY_CACHE_TTL_SECONDS}`,
              },
            });
            // Best-effort: a failed put costs the next view one page-walk.
            await cache.put(discoveryCacheUrl(did), body).catch(() => {});
          }
        }

        // Already-imported flags: the shared ledger rule (~/lib/import-flags —
        // published, or still pointing at a live draft, counts; a discarded
        // draft's row does not, so re-importing is the writer's way back).
        // A thread's ledger identity is its ROOT at:// URI.
        const hashes = await Promise.all(
          discovered.threads.map((thread) => guidHash(thread.rootUri)),
        );
        const imported =
          hashes.length > 0
            ? await computeImportedSet(db, did, hashes)
            : new Set<string>();

        const [{ n: draftCount }] = await countDrafts(db, did);
        return privateJson({
          ok: true,
          truncated: discovered.truncated,
          draftSlotsRemaining: Math.max(0, MAX_DRAFTS_PER_USER - draftCount),
          threads: discovered.threads.map((thread, i) => ({
            ...thread,
            guidHash: hashes[i],
            alreadyImported: imported.has(hashes[i]),
          })),
        });
      },
    },
  },
});
