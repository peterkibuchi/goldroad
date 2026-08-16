/**
 * Takedown checks. trygoldroad.com renders and
 * proxies arbitrary third-party atproto content, making it a host/republisher —
 * so it needs a lever to stop serving a given author or record. The reader
 * loaders (404) and the /img proxy (451) consult the D1 `hidden_content` list
 * before serving.
 *
 * FRESHNESS CAVEAT: the reader-page check runs in the loader, which a warm read
 * cache short-circuits — so a takedown on an already-cached page is only
 * enforced once that cache entry expires (≤60 s, see read-cache.ts) OR the
 * cache is purged. A takedown is a row in `hidden_content` keyed on the DID or
 * AT-URI; inserting that row is therefore only half of an URGENT (legal/CSAM)
 * takedown — the edge cache must be purged for the same URLs in the same
 * breath, or the content keeps being served until the entry ages out. The /img
 * check runs BEFORE its cache, so image takedowns are immediate.
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

/** Which of these subjects (DIDs and/or AT-URIs) are on the takedown list?
 * Same one-indexed-IN()-query shape as anyHidden, but returns the matching
 * subjects so list surfaces (the RSS feed) can EXCLUDE individual hidden
 * records while still serving the rest. */
export async function hiddenSubjects(
  db: DrizzleD1,
  subjects: string[],
): Promise<Set<string>> {
  const unique = [...new Set(subjects.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ subject: hiddenContent.subject })
    .from(hiddenContent)
    .where(inArray(hiddenContent.subject, unique))
    .all();
  return new Set(rows.map((row) => row.subject));
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
