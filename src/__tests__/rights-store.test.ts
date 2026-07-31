// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { MAX_DRAFTS_PER_USER } from "../lib/drafts-schema";
import {
  countDraftsForDid,
  countImportItemsForDid,
  deleteDraftsForDid,
  deleteFollowerSnapshotsForDid,
  deleteImportFetchesForDid,
  deleteImportItemsForDid,
  deleteOAuthSessionForDid,
  deleteScheduledPostsForDid,
  MAX_LEDGER_ROWS_PER_EXPORT,
  MAX_SNAPSHOT_ROWS_PER_EXPORT,
  selectDraftsForExport,
  selectFollowerSnapshotsForExport,
  selectImportItemsForExport,
  selectScheduledPostsForExport,
} from "../lib/rights-store";

/**
 * Ownership lives in the SQL (same contract as drafts.test.ts /
 * import-store.test.ts): every read/delete here is a bulk "all of this
 * writer's rows" query, so the ONE thing that must be pinned is that the DID
 * filter is really in the WHERE clause — a query missing it would sweep every
 * writer's rows, which is exactly the cross-DID leak this store exists to
 * prevent. Pinned via .toSQL() without a live D1.
 */
// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);
const DID = "did:plc:fake2222222222writer2222";
const OTHER_DID = "did:plc:fakeforeign22222writer22";

function expectDidBound(sql: string, params: unknown[]) {
  expect(sql.toLowerCase()).toContain("where");
  expect(sql).toContain('"did"');
  expect(params).toContain(DID);
  expect(params).not.toContain(OTHER_DID);
}

describe("counts — the /settings 'your data' readout", () => {
  it("countDraftsForDid filters to the caller's DID", () => {
    const { sql, params } = countDraftsForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('from "drafts"');
  });

  it("countImportItemsForDid filters to the caller's DID", () => {
    const { sql, params } = countImportItemsForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('from "import_items"');
  });
});

describe("export reads — full content, capped, DID-scoped", () => {
  it("selectDraftsForExport binds the DID and caps at the per-writer maximum", () => {
    const { sql, params } = selectDraftsForExport(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain("limit");
    expect([...params, sql].join(" ")).toContain(String(MAX_DRAFTS_PER_USER));
  });

  it("selectDraftsForExport ships full content (unlike the dashboard list)", () => {
    const { sql } = selectDraftsForExport(db, DID).toSQL();
    expect(sql).toContain('"content"');
  });

  it("selectImportItemsForExport binds the DID and caps the row count", () => {
    const { sql, params } = selectImportItemsForExport(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain("limit");
    expect([...params, sql].join(" ")).toContain(
      String(MAX_LEDGER_ROWS_PER_EXPORT),
    );
  });

  it("selectScheduledPostsForExport binds the DID and ships the failure reason", () => {
    const { sql, params } = selectScheduledPostsForExport(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('from "scheduled_posts"');
    // If we hold a reason a writer's post did not go out, it goes out with
    // their data — not summarised, not withheld.
    expect(sql).toContain('"last_error"');
    expect(sql.toLowerCase()).toContain("limit");
  });

  it("selectFollowerSnapshotsForExport binds the DID, orders by day, and caps", () => {
    const { sql, params } = selectFollowerSnapshotsForExport(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('from "follower_snapshots"');
    expect(sql.toLowerCase()).toContain("order by");
    expect(sql.toLowerCase()).toContain("limit");
    expect([...params, sql].join(" ")).toContain(
      String(MAX_SNAPSHOT_ROWS_PER_EXPORT),
    );
  });
});

describe("account-deletion deletes — DID-scoped, RETURNing so callers can see what fell", () => {
  it("deleteDraftsForDid deletes only the caller's rows", () => {
    const { sql, params } = deleteDraftsForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('delete from "drafts"');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteImportItemsForDid deletes only the caller's rows", () => {
    const { sql, params } = deleteImportItemsForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('delete from "import_items"');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteImportFetchesForDid deletes only the caller's rows", () => {
    const { sql, params } = deleteImportFetchesForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('delete from "import_fetches"');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteFollowerSnapshotsForDid deletes only the caller's history", () => {
    const { sql, params } = deleteFollowerSnapshotsForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('delete from "follower_snapshots"');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteScheduledPostsForDid removes queued publishing work, not just records", () => {
    // A pending row is an INSTRUCTION TO PUBLISH. Leaving one behind would
    // have a cron acting for a deleted account an hour later.
    const { sql, params } = deleteScheduledPostsForDid(db, DID).toSQL();
    expectDidBound(sql, params);
    expect(sql.toLowerCase()).toContain('delete from "scheduled_posts"');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteOAuthSessionForDid targets the exact sess:<did> key, not a prefix scan", () => {
    const { sql, params } = deleteOAuthSessionForDid(db, DID).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "oauth_kv"');
    expect(sql.toLowerCase()).toContain("returning");
    // Exact equality on "sess:<did>" — never a LIKE/prefix match, so this can
    // never reach another writer's session row even if DIDs shared a prefix.
    expect(sql.toLowerCase()).not.toContain("like");
    expect(params).toContain(`sess:${DID}`);
    expect(params).not.toContain(`sess:${OTHER_DID}`);
  });
});
