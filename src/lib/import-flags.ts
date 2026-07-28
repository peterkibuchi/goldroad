/**
 * "Already imported" resolution, shared by /api/import (feed path) and
 * /api/import/status (export-upload path). One rule, stated once: a guid
 * counts as imported when its ledger row PUBLISHED, or still points at a
 * LIVE draft. A row whose unpublished draft was deleted does NOT count —
 * the writer discarded that copy; re-importing is their honest path back.
 *
 * Queries run in chunks: D1 binds at most ~100 parameters per statement, and
 * the export path can legitimately carry hundreds of hashes where the feed
 * path caps at 20.
 */
import type { drizzle } from "drizzle-orm/d1";

import { selectImportItems, selectLiveDraftIds } from "~/lib/import-store";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Keys per IN() — comfortably under D1's bound-parameter ceiling. */
export const LEDGER_QUERY_CHUNK = 50;

export async function computeImportedSet(
  db: DrizzleD1,
  did: string,
  guidHashes: string[],
): Promise<Set<string>> {
  const imported = new Set<string>();
  for (let i = 0; i < guidHashes.length; i += LEDGER_QUERY_CHUNK) {
    const ledger = await selectImportItems(
      db,
      did,
      guidHashes.slice(i, i + LEDGER_QUERY_CHUNK),
    );
    const unpublishedDraftIds = ledger
      .filter((row) => !row.publishedRkey && row.draftId)
      .map((row) => row.draftId as string);
    const liveDrafts = new Set(
      (unpublishedDraftIds.length > 0
        ? await selectLiveDraftIds(db, did, unpublishedDraftIds)
        : []
      ).map((row) => row.id),
    );
    for (const row of ledger) {
      if (
        row.publishedRkey !== null ||
        (row.draftId !== null && liveDrafts.has(row.draftId))
      ) {
        imported.add(row.guidHash);
      }
    }
  }
  return imported;
}
