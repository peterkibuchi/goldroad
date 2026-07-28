/**
 * Import-ledger store — the D1 queries behind /api/import, /api/import/draft,
 * the publish write-back, and the reader's mirror lookup. Same contract as
 * ~/lib/drafts: OWNERSHIP IS ENFORCED HERE — every query pairs its keys with
 * the owner DID in the WHERE, so a caller can never reach another writer's
 * ledger. Functions return drizzle query builders (awaitable), unit-testable
 * via .toSQL() without a live D1.
 */
import { and, count, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { drafts, importFetches, importItems } from "~/db/schema";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Ledger rows for a set of item hashes — the picker's "already imported"
 * flags. `guidHashes` is capped upstream (items per run ≤ 20). */
export function selectImportItems(
  db: DrizzleD1,
  did: string,
  guidHashes: string[],
) {
  return db
    .select({
      guidHash: importItems.guidHash,
      draftId: importItems.draftId,
      publishedRkey: importItems.publishedRkey,
    })
    .from(importItems)
    .where(
      and(eq(importItems.did, did), inArray(importItems.guidHash, guidHashes)),
    );
}

/** One ledger row by its dedupe key. */
export function selectImportItem(db: DrizzleD1, did: string, guidHash: string) {
  return db
    .select()
    .from(importItems)
    .where(and(eq(importItems.did, did), eq(importItems.guidHash, guidHash)))
    .limit(1);
}

/** The ledger row behind a draft, if that draft came from an import —
 * publish reads this to backdate the record and fetch a cover. */
export function selectImportItemByDraft(
  db: DrizzleD1,
  did: string,
  draftId: string,
) {
  return db
    .select()
    .from(importItems)
    .where(and(eq(importItems.did, did), eq(importItems.draftId, draftId)))
    .limit(1);
}

/**
 * Is this published record a mirror? A row with the rkey, still un-adopted.
 * The reader page turns a hit into noindex + the provenance line.
 */
export function selectMirror(
  db: DrizzleD1,
  did: string,
  publishedRkey: string,
) {
  return db
    .select({
      sourceUrl: importItems.sourceUrl,
    })
    .from(importItems)
    .where(
      and(
        eq(importItems.did, did),
        eq(importItems.publishedRkey, publishedRkey),
        isNull(importItems.adoptedAt),
      ),
    )
    .limit(1);
}

/** Creates a ledger row. `id` is minted by the caller (crypto.randomUUID()). */
export function insertImportItem(
  db: DrizzleD1,
  row: {
    id: string;
    did: string;
    guidHash: string;
    sourceUrl: string | null;
    originalAt: Date | null;
    draftId: string;
  },
) {
  return db.insert(importItems).values(row).returning({ id: importItems.id });
}

/**
 * Re-points an existing ledger row at a fresh draft — the "the writer deleted
 * the unpublished draft, then imported the item again" path. Guarded to
 * never-published rows only: a published item stays refused as a duplicate.
 */
export function reviveImportItem(
  db: DrizzleD1,
  did: string,
  guidHash: string,
  fields: {
    draftId: string;
    sourceUrl: string | null;
    originalAt: Date | null;
  },
) {
  return db
    .update(importItems)
    .set(fields)
    .where(
      and(
        eq(importItems.did, did),
        eq(importItems.guidHash, guidHash),
        isNull(importItems.publishedRkey),
      ),
    )
    .returning({ id: importItems.id });
}

/** Publish write-back: records the rkey the draft published under. */
export function setPublishedRkey(
  db: DrizzleD1,
  did: string,
  draftId: string,
  publishedRkey: string,
) {
  return db
    .update(importItems)
    .set({ publishedRkey })
    .where(and(eq(importItems.did, did), eq(importItems.draftId, draftId)))
    .returning({ id: importItems.id });
}

/**
 * Record-deletion cleanup: when a published document is deleted from the
 * writer's repo, its ledger row must stop counting as "imported" — otherwise
 * the guid is refused as a duplicate forever and the item can never come
 * back. Clears the publish state (rkey, dangling draft id, adoption) but
 * keeps the row itself, so a later re-import walks the same revive path as
 * a discarded draft. Matches zero rows for never-imported documents — safe
 * to call for every delete.
 */
export function clearPublishedImport(
  db: DrizzleD1,
  did: string,
  publishedRkey: string,
) {
  return db
    .update(importItems)
    .set({ publishedRkey: null, draftId: null, adoptedAt: null })
    .where(
      and(
        eq(importItems.did, did),
        eq(importItems.publishedRkey, publishedRkey),
      ),
    )
    .returning({ id: importItems.id });
}

/** Adoption: the writer makes the post the Goldroad original — the mirror
 * treatment (noindex + provenance line) stops; the row stays for dedupe. */
export function adoptMirror(
  db: DrizzleD1,
  did: string,
  publishedRkey: string,
  now: Date = new Date(),
) {
  return db
    .update(importItems)
    .set({ adoptedAt: now })
    .where(
      and(
        eq(importItems.did, did),
        eq(importItems.publishedRkey, publishedRkey),
        isNull(importItems.adoptedAt),
      ),
    )
    .returning({ id: importItems.id });
}

/** Which of these draft ids still exist for this writer — distinguishes
 * "imported and still sitting in drafts" from "imported, then discarded". */
export function selectLiveDraftIds(
  db: DrizzleD1,
  did: string,
  draftIds: string[],
) {
  return db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.did, did), inArray(drafts.id, draftIds)));
}

/** Feed-fetch runs this writer has spent since `since` (the rate window). */
export function countRecentImportFetches(
  db: DrizzleD1,
  did: string,
  since: Date,
) {
  return db
    .select({ n: count() })
    .from(importFetches)
    .where(
      and(eq(importFetches.did, did), gte(importFetches.createdAt, since)),
    );
}

/** Records a feed-fetch run (counted before the fetch happens — a failed
 * fetch still spent the attempt). */
export function insertImportFetch(db: DrizzleD1, did: string) {
  return db.insert(importFetches).values({ did });
}

/** Inline prune: rows older than the window are dead weight for every
 * writer — one indexed DELETE per run keeps the table tiny without a cron. */
export function pruneImportFetches(db: DrizzleD1, before: Date) {
  return db.delete(importFetches).where(lt(importFetches.createdAt, before));
}
