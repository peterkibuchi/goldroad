/**
 * "Already imported" resolution, shared by /api/import (feed path) and
 * /api/import/status (export-upload path). One rule, stated once: a guid
 * counts as imported when its ledger row PUBLISHED, or still points at a
 * LIVE draft. A row whose unpublished draft was deleted does NOT count —
 * the writer discarded that copy; re-importing is their honest path back.
 *
 * Chunking is forced by D1: a statement binds at most ~100 parameters, so a
 * 1000-post archive needs 20 IN() lookups however you arrange them. What is
 * NOT forced is how many round trips those become. Awaiting each chunk in
 * turn — and each chunk's live-draft follow-up after it — cost up to 40
 * SEQUENTIAL D1 calls for one /api/import/status request: 40 serial latencies,
 * and ~40 of the 50 subrequests a free-tier Worker gets per request.
 *
 * So the chunks go out as two `db.batch()` calls instead — every ledger
 * lookup in one batch, then every live-draft lookup in one batch (the second
 * phase genuinely depends on the first: it queries the draft ids the ledger
 * returned). Two round trips, flat, whatever the archive's size. Same reason
 * /api/import/draft batches its draft+ledger insert.
 */
import type { drizzle } from "drizzle-orm/d1";

import { selectImportItems, selectLiveDraftIds } from "~/lib/import-store";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Keys per IN() — comfortably under D1's bound-parameter ceiling. */
export const LEDGER_QUERY_CHUNK = 50;

/** `db.batch()` is typed for a non-empty tuple; both call sites below check
 * for emptiness first, which the cast records. */
type NonEmpty<T> = [T, ...T[]];

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function computeImportedSet(
  db: DrizzleD1,
  did: string,
  guidHashes: string[],
): Promise<Set<string>> {
  const imported = new Set<string>();
  if (guidHashes.length === 0) return imported;

  const ledgerQueries = chunked(guidHashes, LEDGER_QUERY_CHUNK).map((keys) =>
    selectImportItems(db, did, keys),
  ) as NonEmpty<ReturnType<typeof selectImportItems>>;
  const ledger = (await db.batch(ledgerQueries)).flat();

  // Deduped ACROSS chunks, not within one: two ledger rows in different
  // chunks can point at the same draft, and every duplicate would otherwise
  // spend a bound parameter (and, at the boundary, a whole extra statement).
  const unpublishedDraftIds = [
    ...new Set(
      ledger
        .filter((row) => !row.publishedRkey && row.draftId)
        .map((row) => row.draftId as string),
    ),
  ];
  const liveDrafts = new Set<string>();
  if (unpublishedDraftIds.length > 0) {
    const draftQueries = chunked(unpublishedDraftIds, LEDGER_QUERY_CHUNK).map(
      (ids) => selectLiveDraftIds(db, did, ids),
    ) as NonEmpty<ReturnType<typeof selectLiveDraftIds>>;
    for (const rows of await db.batch(draftQueries)) {
      for (const row of rows) liveDrafts.add(row.id);
    }
  }

  for (const row of ledger) {
    if (
      row.publishedRkey !== null ||
      (row.draftId !== null && liveDrafts.has(row.draftId))
    ) {
      imported.add(row.guidHash);
    }
  }
  return imported;
}
