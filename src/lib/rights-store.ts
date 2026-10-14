/**
 * Account-rights store — the D1 queries behind /api/account/export and
 * /api/account/delete (the "Your data" section on /settings). Same ownership
 * contract as ~/lib/drafts and ~/lib/import-store: every query pairs its rows
 * with the caller's DID, so a caller can only ever read or delete their own
 * rows — never another writer's. Functions return drizzle query builders
 * (awaitable), unit-testable via .toSQL() without a live D1.
 *
 * Scope, deliberately narrow (see AGENTS.md architectural note): these are
 * the ONLY places a writer's DID appears in our D1 — drafts, import_items,
 * import_fetches, follower_snapshots, scheduled_posts, reader_emails,
 * handle_history, hosted_publications, search_documents, search_backfills,
 * and the oauth_kv session row. Published posts live in the
 * writer's own atproto repo and are never touched here; deleting an account
 * purges our copies only.
 *
 * Anything new that stores a DID belongs in both halves of this file, in the
 * same change that creates it. A table that ships without its export and
 * delete wiring is how an instance ends up holding rows nobody can reach —
 * which is exactly what happened to `reader_emails`, keyed by `writer_did`
 * and missed by both halves for as long as it existed.
 *
 * READER EMAILS: the writer is the controller of their publication's reader
 * list, and Goldroad processes it on their behalf. So the export hands the
 * writer the addresses, with where and when each was left, and deleting the
 * account deletes them: a closed account cannot go on holding other people's
 * addresses.
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
  handleHistory,
  hostedPublications,
  importFetches,
  importItems,
  oauthKv,
  readerEmails,
  scheduledPosts,
  searchBackfills,
  searchDocuments,
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

/** The writer's publication as the sitemap lists it (at most one row). */
export function selectHostedPublicationForExport(db: DrizzleD1, did: string) {
  return db
    .select({
      ident: hostedPublications.ident,
      updatedAt: hostedPublications.updatedAt,
    })
    .from(hostedPublications)
    .where(eq(hostedPublications.did, did));
}

/**
 * A writer's scheduled posts — pending, failed and recently published alike.
 *
 * Included in the export because it is a record of the writer's own intent
 * ("this piece was to go out on Tuesday") that exists nowhere else, and because
 * `last_error` is our account of why something of theirs did not happen. If we
 * hold a reason a writer's post failed, they get to read it in full.
 *
 * Capped by the same defensive bound as the import ledger, NOT by the
 * hundred-row bound the posts manager's live queue uses: this reads finished
 * rows too, so a busy month could exceed that and quietly drop the newest —
 * including a pending post — from a writer's own copy of their data.
 */
export function selectScheduledPostsForExport(db: DrizzleD1, did: string) {
  return db
    .select({
      draftId: scheduledPosts.draftId,
      dueAt: scheduledPosts.dueAt,
      status: scheduledPosts.status,
      attempts: scheduledPosts.attempts,
      lastError: scheduledPosts.lastError,
      publishedRkey: scheduledPosts.publishedRkey,
      createdAt: scheduledPosts.createdAt,
    })
    .from(scheduledPosts)
    .where(eq(scheduledPosts.did, did))
    .orderBy(asc(scheduledPosts.dueAt))
    .limit(MAX_LEDGER_ROWS_PER_EXPORT);
}

/** The handles we recorded for this writer — the export's handle section. */
export function selectHandleHistoryForExport(db: DrizzleD1, did: string) {
  return db
    .select({ handle: handleHistory.handle, seenAt: handleHistory.seenAt })
    .from(handleHistory)
    .where(eq(handleHistory.did, did));
}

/** Forgets this writer's handles (account deletion): links under them stop
 * redirecting, which is what a closed account should mean. */
export function deleteHandleHistoryForDid(db: DrizzleD1, did: string) {
  return db.delete(handleHistory).where(eq(handleHistory.did, did));
}

/**
 * The addresses readers have left with this writer's publication, oldest
 * first, with the surface each was left on and when. Uncapped on purpose: a
 * truncated list is a list the writer can't trust.
 */
export function selectReaderEmailsForExport(db: DrizzleD1, did: string) {
  return db
    .select({
      email: readerEmails.email,
      source: readerEmails.source,
      consentedAt: readerEmails.consentedAt,
    })
    .from(readerEmails)
    .where(eq(readerEmails.writerDid, did))
    .orderBy(asc(readerEmails.consentedAt), asc(readerEmails.id));
}

/**
 * Deletes every reader address left with this writer's publication (account
 * deletion).
 *
 * Not housekeeping. These are third parties' email addresses that we hold for
 * one reason only — that this writer has a publication people wanted to hear
 * from — and when the publication's account is gone that reason is gone with
 * it. Rows that outlived it would be a list of personal data with no purpose,
 * no controller and nobody able to reach them: the exact shape of the leak
 * this file's contract exists to prevent.
 */
export function deleteReaderEmailsForDid(db: DrizzleD1, did: string) {
  return db
    .delete(readerEmails)
    .where(eq(readerEmails.writerDid, did))
    .returning({ id: readerEmails.id });
}

/**
 * Deletes every scheduled post a writer owns (account deletion).
 *
 * This one is not merely housekeeping: a pending row is an INSTRUCTION TO
 * PUBLISH that a cron would otherwise pick up an hour after the account was
 * deleted. Its draft is gone by then and its session is revoked, so it could
 * only ever fail — but a deleted account must not leave work queued in our
 * scheduler at all.
 */
export function deleteScheduledPostsForDid(db: DrizzleD1, did: string) {
  return db
    .delete(scheduledPosts)
    .where(eq(scheduledPosts.did, did))
    .returning({ id: scheduledPosts.id });
}

/** Deletes the search index of a writer's posts (account deletion). It is
 * our copy of their words, so it goes with everything else; the triggers on
 * `search_documents` take the FTS5 entries with it. */
export function deleteSearchDocumentsForDid(db: DrizzleD1, did: string) {
  return db
    .delete(searchDocuments)
    .where(eq(searchDocuments.did, did))
    .returning({ id: searchDocuments.id });
}

/** Deletes a writer's search-backfill progress (account deletion). */
export function deleteSearchBackfillForDid(db: DrizzleD1, did: string) {
  return db
    .delete(searchBackfills)
    .where(eq(searchBackfills.did, did))
    .returning({ did: searchBackfills.did });
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

/** Deletes the writer's sitemap listing (account deletion). A publish would
 * re-create it, and a deleted account can't publish. */
export function deleteHostedPublicationForDid(db: DrizzleD1, did: string) {
  return db
    .delete(hostedPublications)
    .where(eq(hostedPublications.did, did))
    .returning({ did: hostedPublications.did });
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
