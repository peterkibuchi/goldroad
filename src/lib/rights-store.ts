/**
 * Account-rights store — the D1 queries behind /api/account/export and
 * /api/account/delete (the "Your data" section on /settings). Same ownership
 * contract as ~/lib/drafts and ~/lib/import-store: every query pairs its rows
 * with the caller's DID, so a caller can only ever read or delete their own
 * rows — never another writer's. Functions return drizzle query builders
 * (awaitable), unit-testable via .toSQL() without a live D1.
 *
 * Scope, deliberately narrow (see AGENTS.md architectural note): these are
 * the ONLY four places a writer's DID appears in our D1 — drafts,
 * import_items, import_fetches, and the oauth_kv session row. Published
 * posts live in the writer's own atproto repo and are never touched here;
 * deleting an account purges our copies only.
 */
import { desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { drafts, importFetches, importItems, oauthKv } from "~/db/schema";
import { MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";

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

/** All of a writer's import-ledger rows — the export download's import
 * section. */
export function selectImportItemsForExport(db: DrizzleD1, did: string) {
  return db
    .select()
    .from(importItems)
    .where(eq(importItems.did, did))
    .limit(MAX_LEDGER_ROWS_PER_EXPORT);
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
