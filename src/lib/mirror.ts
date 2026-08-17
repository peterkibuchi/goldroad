/**
 * Reader-side provenance lookup: did this published post come in through an
 * import, and if so, from where? The record in the writer's repo is ordinary
 * either way (publication-attached, announceable); the provenance lives HERE,
 * page-level.
 *
 * The treatment splits on `sourceKind`, and the split is the whole point:
 *
 * - `feed` — a MIRROR. The original is someone else's publication and is still
 *   up, so the reader swaps this page's canonical tag for noindex and says
 *   "Originally published at …". That matches current search-engine
 *   syndication etiquette (noindex the republished copy; a cross-domain
 *   canonical can't verify and is no longer recommended).
 * - `thread` — a SELF-IMPORT. The original is the writer's own Bluesky thread,
 *   which was never a canonical web page and is not competing for the same
 *   query: there is no indexed URL to defer to, and noindex-ing this page would
 *   hide the only long-form version of the writer's own words. So the canonical
 *   STAYS HERE and the page states its origin without disowning itself —
 *   "First published as a thread on Bluesky".
 *
 * Server function for the same reason as ~/lib/moderation's checkHidden: the
 * reader loaders are isomorphic, and wrapping the D1 read keeps the
 * `cloudflare:workers` binding out of the client bundle. Fail-open on a D1
 * error (null = treat as not-imported): a transient store outage must not
 * blank canonical tags across the reader; the check re-runs on the next
 * uncached request. Same freshness caveat as moderation: the read cache can
 * serve a stale verdict for up to its TTL (≤60 s).
 *
 * Server function for the same reason as ~/lib/moderation's checkHidden: the
 * reader loaders are isomorphic, and wrapping the D1 read keeps the
 * `cloudflare:workers` binding out of the client bundle. Fail-open on a D1
 */
import { createServerFn } from "@tanstack/react-start";
import { drizzle } from "drizzle-orm/d1";

import { type ImportSourceKind, selectMirror } from "~/lib/import-store";
import { env } from "cloudflare:workers";

export type MirrorInfo = {
  sourceUrl: string | null;
  /** Which provenance treatment this page gets — see the file header. An
   * unrecognised stored value reads as `feed`, the conservative answer: it
   * keeps noindex on a page we are no longer sure we own the original of. */
  kind: ImportSourceKind;
};

/** Only a thread self-import keeps its canonical here. */
export function keepsCanonical(mirror: MirrorInfo | null | undefined): boolean {
  return mirror == null || mirror.kind === "thread";
}

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

/** Null = not imported (or adopted, or the lookup flaked — fail open). */
export const checkMirror = createServerFn({ method: "GET" })
  .validator(mirrorInput)
  .handler(async ({ data }): Promise<MirrorInfo | null> => {
    if (!env.DB || !data.did || !data.rkey) return null;
    try {
      const [row] = await selectMirror(drizzle(env.DB), data.did, data.rkey);
      if (!row) return null;
      return {
        sourceUrl: row.sourceUrl,
        kind: row.sourceKind === "thread" ? "thread" : "feed",
      };
    } catch (err) {
      console.error("provenance check failed", err);
      return null;
    }
  });
