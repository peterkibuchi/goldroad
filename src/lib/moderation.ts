/**
 * Takedown checks (moderation kit, audit #1). trygoldroad.com renders and
 * proxies arbitrary third-party atproto content, making it a host/republisher —
 * so it needs a lever to stop serving a given author or record. The reader
 * loaders (404) and the /img proxy (451) consult the D1 `hidden_content` list
 * before serving.
 *
 * FRESHNESS CAVEAT: the reader-page check runs in the loader, which a warm read
 * cache short-circuits — so a takedown on an already-cached page is only
 * enforced once that cache entry expires (≤60 s, see read-cache.ts) OR the
 * cache is purged. An urgent (legal/CSAM) takedown MUST purge, not just insert
 * the hide row (scripts/takedown.mjs does both). The /img check runs BEFORE its
 * cache, so image takedowns are immediate.
 *
 * `anyHidden` is pure (db injected) so it unit-tests without a live D1 and so
 * the /img route (which already holds `env.DB`) can call it directly.
 * `checkHidden` is a server function for the reader loaders, which are
 * isomorphic — wrapping the D1 read guarantees it runs server-side and keeps
 * the `cloudflare:workers` binding out of the client bundle.
 *
 * Fail-open on a D1 error (log, treat as not-hidden): a transient store outage
 * must not blank the whole reader. Accepted tradeoff (availability over
 * enforcement); the check re-runs on the next uncached request.
 */
import { createServerFn } from "@tanstack/react-start";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { hiddenContent } from "~/db/schema";
import { env } from "cloudflare:workers";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** AT-URI for a record subject (the hide-list's record-level key). */
export function recordAtUri(
  did: string,
  collection: string,
  rkey: string,
): string {
  return `at://${did}/${collection}/${rkey}`;
}

/** Is any of these subjects (a DID and/or an AT-URI) on the takedown list?
 * One indexed IN() query; empty/blank input short-circuits to false. */
export async function anyHidden(
  db: DrizzleD1,
  subjects: string[],
): Promise<boolean> {
  const unique = [...new Set(subjects.filter(Boolean))];
  if (unique.length === 0) return false;
  const row = await db
    .select({ id: hiddenContent.id })
    .from(hiddenContent)
    .where(inArray(hiddenContent.subject, unique))
    .get();
  return row != null;
}

/**
 * Subjects to check, extracted from the reader loaders' input. The input is an
 * OBJECT of string fields (`did`, optional `atUri`), NOT an array: a GET server
 * function encodes its input into the URL, and arrays don't survive that
 * round-trip — an object of strings does (same shape the dashboard loader uses
 * for its cursor). Exported so the validator and its regression test share one
 * definition of the contract.
 */
export function hiddenSubjectsFromInput(data: {
  did?: unknown;
  atUri?: unknown;
}): string[] {
  const did = typeof data?.did === "string" ? data.did : "";
  const atUri = typeof data?.atUri === "string" ? data.atUri : "";
  return [did, atUri].filter(Boolean);
}

/**
 * Server-only takedown check for the reader loaders. Wrapping the D1 read in a
 * server function keeps the `cloudflare:workers` binding out of the client
 * bundle, which an isomorphic loader would otherwise pull in. The loader turns
 * a `true` into `throw notFound({ data: { hidden: true } })` — a reliable 404
 * with the takedown notice, rather than the writer's content.
 */
export const checkHidden = createServerFn({ method: "GET" })
  .validator(hiddenSubjectsFromInput)
  .handler(async ({ data }) => {
    if (!env.DB || data.length === 0) return false;
    try {
      return await anyHidden(drizzle(env.DB), data);
    } catch (err) {
      console.error("hidden-content check failed", err);
      return false;
    }
  });
