// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  adoptMirror,
  countRecentImportFetches,
  insertImportFetch,
  insertImportItem,
  pruneImportFetches,
  reviveImportItem,
  selectImportItem,
  selectImportItemByDraft,
  selectImportItems,
  selectLiveDraftIds,
  selectMirror,
  setPublishedRkey,
} from "../lib/import-store";

/**
 * Ownership lives in the SQL (same contract as drafts.test.ts): every ledger
 * query must pair its keys with the owner DID in the WHERE, pinned via
 * .toSQL() without a live D1. Plus the mirror/adoption semantics: mirror
 * lookups must exclude adopted rows; revives must never touch published rows.
 */
// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);
const DID = "did:plc:fake2222222222writer2222";
const HASH = "a".repeat(64);
const DRAFT_ID = "11111111-2222-3333-4444-555555555555";
const RKEY = "3lz2222222222";

function expectDidBound(sql: string, params: unknown[]) {
  expect(sql.toLowerCase()).toContain("where");
  expect(sql).toContain('"did"');
  expect(params).toContain(DID);
}

describe("ledger reads bind the owner DID", () => {
  it("selectImportItems (dedupe flags)", () => {
    const { sql, params } = selectImportItems(db, DID, [HASH]).toSQL();
    expectDidBound(sql, params);
    expect(sql).toContain('"guid_hash"');
    expect(params).toContain(HASH);
  });

  it("selectImportItem (single dedupe check)", () => {
    const { sql, params } = selectImportItem(db, DID, HASH).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(HASH);
  });

  it("selectImportItemByDraft (publish-time lookup)", () => {
    const { sql, params } = selectImportItemByDraft(db, DID, DRAFT_ID).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(DRAFT_ID);
  });

  it("selectLiveDraftIds pairs the DID with the id set", () => {
    const { sql, params } = selectLiveDraftIds(db, DID, [DRAFT_ID]).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(DRAFT_ID);
  });
});

describe("mirror lookup and adoption", () => {
  it("selectMirror matches rkey + DID and EXCLUDES adopted rows", () => {
    const { sql, params } = selectMirror(db, DID, RKEY).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(RKEY);
    expect(sql.toLowerCase()).toContain('"adopted_at" is null');
  });

  it("adoptMirror sets adopted_at only on the un-adopted row, RETURNING", () => {
    const now = new Date("2026-07-28T00:00:00Z");
    const { sql, params } = adoptMirror(db, DID, RKEY, now).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(RKEY);
    expect(sql).toContain('"adopted_at"');
    expect(sql.toLowerCase()).toContain('"adopted_at" is null');
    expect(sql.toLowerCase()).toContain("returning");
  });
});

describe("ledger writes", () => {
  it("insertImportItem writes the caller's row", () => {
    const { sql, params } = insertImportItem(db, {
      id: "id-1",
      did: DID,
      guidHash: HASH,
      sourceUrl: "https://writer.substack.com/p/x",
      originalAt: new Date("2025-01-01T00:00:00Z"),
      draftId: DRAFT_ID,
    }).toSQL();
    expect(sql.toLowerCase()).toContain('insert into "import_items"');
    expect(params).toEqual(
      expect.arrayContaining([
        DID,
        HASH,
        DRAFT_ID,
        "https://writer.substack.com/p/x",
      ]),
    );
  });

  it("reviveImportItem re-points ONLY never-published rows", () => {
    const { sql, params } = reviveImportItem(db, DID, HASH, {
      draftId: DRAFT_ID,
      sourceUrl: null,
      originalAt: null,
    }).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(HASH);
    expect(sql.toLowerCase()).toContain('"published_rkey" is null');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("setPublishedRkey binds did + draftId and writes the rkey", () => {
    const { sql, params } = setPublishedRkey(db, DID, DRAFT_ID, RKEY).toSQL();
    expectDidBound(sql, params);
    expect(params).toContain(DRAFT_ID);
    expect(params).toContain(RKEY);
  });
});

describe("rate-limit ledger", () => {
  const since = new Date("2026-07-28T00:00:00Z");

  it("countRecentImportFetches counts this writer inside the window", () => {
    const { sql, params } = countRecentImportFetches(db, DID, since).toSQL();
    expect(sql.toLowerCase()).toContain("count");
    expectDidBound(sql, params);
    expect(sql).toContain('"created_at"');
  });

  it("insertImportFetch records the run for the writer", () => {
    const { sql, params } = insertImportFetch(db, DID).toSQL();
    expect(sql.toLowerCase()).toContain('insert into "import_fetches"');
    expect(params).toContain(DID);
  });

  it("pruneImportFetches deletes only rows older than the cutoff", () => {
    const { sql } = pruneImportFetches(db, since).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "import_fetches"');
    expect(sql).toContain('"created_at"');
    expect(sql).toContain("<");
  });
});
