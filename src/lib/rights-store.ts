/**
 * Account-rights store — the D1 queries behind /api/account/export and
 * /api/account/delete (the "Your data" section on /settings). Same ownership
 * contract as ~/lib/drafts and ~/lib/import-store: every query pairs its rows
 * with the caller's DID, so a caller can only ever read or delete their own
 * rows — never another writer's. Functions return drizzle query builders
 * (awaitable), unit-testable via .toSQL() without a live D1.
 *
 * Scope, deliberately narrow (see AGENTS.md architectural note): these are
 * the ONLY five places a writer's DID appears in our D1 — drafts,
 * import_items, import_fetches, follower_snapshots, and the oauth_kv session
 * row. Published posts live in the writer's own atproto repo and are never
 * touched here; deleting an account purges our copies only.
 *
 * Anything new that stores a DID belongs in both halves of this file, in the
 * same change that creates it. A table that ships without its export and
 * delete wiring is how an instance ends up holding rows nobody can reach.
 *
 * DELIBERATELY UNREACHABLE FROM HERE: `waitlist` and `reports` also hold an
 * email a writer may have typed, and neither can ever be covered by these
 * functions. Both are written by UNAUTHENTICATED public endpoints
 * (~/routes/api.waitlist, ~/routes/api.report) and both are keyed by the email
 * alone — no DID column, and no DID available to put in one. We never learn a
 * writer's email either: identity is the DID, and the OAuth scopes we request
 * (~/lib/oauth-scopes) carry no way to read the PDS account email. So there is
 * no link to key these queries on, and accepting a client-supplied email
 * instead would let any signed-in caller export or delete a stranger's abuse
 * report on an unverified claim — a worse leak than the gap it closes. The
 * privacy policy and /settings say this in as many words, and by-hand removal
 * on request is the honest remedy; if a verified-email link ever exists, this
 * is the note to come back to.
 */
import { asc, desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import {
  drafts,
  followerSnapshots,
  importFetches,
  importItems,
  oauthKv,
} from "~/db/schema";
import { MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import { SNAPSHOT_RETENTION_DAYS } from "~/lib/follower-snapshots";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Ledger rows returned per export are capped defensively. Unlike drafts,
 * import_items has no insert-time per-writer cap — but realistic usage
 * (imports are rate-limited to a handful of runs an hour, ~20 items each)
 * never approaches this; it exists purely as a guardrail against an
 * unbounded response. */
export const MAX_LEDGER_ROWS_PER_EXPORT = 2000;

/** How many drafts a writer has — shown on /settings before they download. */
export function countDraftsForDid(db: DrizzleD1, did: string) {
  return db.select({ id: drafts.id }).from(drafts).where(eq(drafts.did, did));
}

/** How many import-ledger rows a writer has — shown on /settings before
 * they download. */
export function countImportItemsForDid(db: DrizzleD1, did: string) {
  return db
    .select({ id: importItems.id })
    .from(importItems)
    .where(eq(importItems.did, did));
}

/** All of a writer's drafts, full content — the export download's drafts
 * section. Newest first, capped at the per-writer create-time maximum (a
 * writer can never legitimately have more rows than that anyway). */
export function selectDraftsForExport(db: DrizzleD1, did: string) {
  return db
    .select()
    .from(drafts)
    .where(eq(drafts.did, did))
    .orderBy(desc(drafts.updatedAt))
    .limit(MAX_DRAFTS_PER_USER);
}

/** A writer can hold at most one snapshot per retained day, so the retention
 * window is the natural cap (+1 for the boundary day the prune keeps). */
export const MAX_SNAPSHOT_ROWS_PER_EXPORT = SNAPSHOT_RETENTION_DAYS + 1;

/** All of a writer's import-ledger rows — the export download's import
 * section. */
export function selectImportItemsForExport(db: DrizzleD1, did: string) {
  return db
    .select()
    .from(importItems)
    .where(eq(importItems.did, did))
    .limit(MAX_LEDGER_ROWS_PER_EXPORT);
}

/**
 * A writer's own follower history — the export download's followers section,
 * oldest day first.
 *
 * This is data about them that we hold and they can't reconstruct from
 * anywhere else (upstream reports a follower count for today and keeps no
 * history), so it goes out with the rest of their export as a matter of
 * course, not on request.
 */
export function selectFollowerSnapshotsForExport(db: DrizzleD1, did: string) {
  return db
    .select({
      day: followerSnapshots.day,
      followers: followerSnapshots.followers,
      posts: followerSnapshots.posts,
    })
    .from(followerSnapshots)
    .where(eq(followerSnapshots.did, did))
    .orderBy(asc(followerSnapshots.day))
    .limit(MAX_SNAPSHOT_ROWS_PER_EXPORT);
}

/** Deletes every draft a writer owns (account deletion, not the single-draft
 * delete in ~/lib/drafts). Ownership is the entire WHERE clause: only rows
 * matching this DID are ever touched. */
export function deleteDraftsForDid(db: DrizzleD1, did: string) {
  return db.delete(drafts).where(eq(drafts.did, did)).returning({
    id: drafts.id,
  });
}

/** Deletes every import-ledger row a writer owns (account deletion). */
export function deleteImportItemsForDid(db: DrizzleD1, did: string) {
  return db.delete(importItems).where(eq(importItems.did, did)).returning({
    id: importItems.id,
  });
}

/** Deletes every import-rate-limit row a writer owns (account deletion). */
export function deleteImportFetchesForDid(db: DrizzleD1, did: string) {
  return db
    .delete(importFetches)
    .where(eq(importFetches.did, did))
    .returning({ id: importFetches.id });
}

/** Deletes every follower snapshot a writer owns (account deletion). Their
 * history stops being sampled as soon as the session row goes too, so nothing
 * re-creates these rows afterwards. */
export function deleteFollowerSnapshotsForDid(db: DrizzleD1, did: string) {
  return db
    .delete(followerSnapshots)
    .where(eq(followerSnapshots.did, did))
    .returning({ id: followerSnapshots.id });
}

/**
 * Deletes the writer's D1-side OAuth session row directly. The session store
 * (~/lib/oauth's D1Store) prefixes session keys with "sess:" and keys them by
 * DID (`sessionGetter.setStored(sub, ...)` in @atcute/oauth-node-client, where
 * `sub` is the DID) — so `sess:<did>` is an exact, single-row key, never a
 * prefix scan over other writers' rows.
 *
 * This is deliberate belt-and-braces alongside `createOAuthClient(...).revoke
 * (did)` (best-effort upstream token revocation, same call /logout makes):
 * revoke() calls getSession() BEFORE its try/finally that clears the stored
 * row, so if getSession() throws (e.g. a session already invalid) the D1 row
 * is never reached. Deleting it here directly guarantees the row is gone
 * regardless of what the upstream revoke call does.
 */
export function deleteOAuthSessionForDid(db: DrizzleD1, did: string) {
  return db
    .delete(oauthKv)
    .where(eq(oauthKv.k, `sess:${did}`))
    .returning({
      k: oauthKv.k,
    });
}
