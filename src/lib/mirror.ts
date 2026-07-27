/**
 * Reader-side mirror lookup. A "mirror" is a post that came in through the
 * feed import and whose original still lives elsewhere: the record in the
 * writer's repo is ordinary (publication-attached, announceable), and the
 * mirror-ness lives HERE, page-level — our reader swaps the canonical tag
 * for noindex and shows "Originally published at …". That matches current
 * search-engine syndication etiquette (noindex the republished copy; a
 * cross-domain canonical can't verify and is no longer recommended) while
 * keeping every record mechanism intact.
 *
 * Server function for the same reason as ~/lib/moderation's checkHidden: the
 * reader loaders are isomorphic, and wrapping the D1 read keeps the
 * `cloudflare:workers` binding out of the client bundle. Fail-open on a D1
 * error (null = treat as not-a-mirror): a transient store outage must not
 * blank canonical tags across the reader; the check re-runs on the next
 * uncached request. Same freshness caveat as moderation: the read cache can
 * serve a stale verdict for up to its TTL (≤60 s).
 */
import { createServerFn } from "@tanstack/react-start";
import { drizzle } from "drizzle-orm/d1";

import { selectMirror } from "~/lib/import-store";
import { env } from "cloudflare:workers";

export type MirrorInfo = { sourceUrl: string | null };

/** GET server-fn input must be an object of strings (arrays don't survive
 * the URL round-trip — same constraint as checkHidden's validator). */
function mirrorInput(data: { did?: unknown; rkey?: unknown }): {
  did: string;
  rkey: string;
} {
  return {
    did: typeof data?.did === "string" ? data.did : "",
    rkey: typeof data?.rkey === "string" ? data.rkey : "",
  };
}

/** Null = not a mirror (or adopted, or the lookup flaked — fail open). */
export const checkMirror = createServerFn({ method: "GET" })
  .validator(mirrorInput)
  .handler(async ({ data }): Promise<MirrorInfo | null> => {
    if (!env.DB || !data.did || !data.rkey) return null;
    try {
      const [row] = await selectMirror(drizzle(env.DB), data.did, data.rkey);
      return row ? { sourceUrl: row.sourceUrl } : null;
    } catch (err) {
      console.error("mirror check failed", err);
      return null;
    }
  });
