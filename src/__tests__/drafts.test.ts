// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  countDrafts,
  deleteDraft,
  insertDraft,
  listDrafts,
  selectDraft,
  updateDraft,
} from "../lib/drafts";
import { MAX_DRAFTS_PER_USER } from "../lib/drafts-schema";

/**
 * Ownership lives in the SQL: every single-row query must pair the draft id
 * with the owner DID in its WHERE clause, so no handler bug can reach another
 * writer's draft. These tests pin that — plus ordering and caps — via
 * .toSQL(), without a live D1 (same pattern as scheduled.test.ts).
 */
// Build-only drizzle instance; .toSQL() never touches the (empty) client.
// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);
const DID = "did:plc:fake2222222222writer2222";
const ID = "11111111-2222-3333-4444-555555555555";

/** Both the id and the owner DID must be bound into the statement. */
function expectOwnershipBound(sql: string, params: unknown[]) {
  expect(sql.toLowerCase()).toContain("where");
  expect(sql).toContain('"id"');
  expect(sql).toContain('"did"');
  expect(params).toContain(DID);
  expect(params).toContain(ID);
}

describe("listDrafts — the dashboard/list query", () => {
  const { sql, params } = listDrafts(db, DID).toSQL();

  it("filters to the owner DID", () => {
    expect(sql.toLowerCase()).toContain("where");
    expect(params).toContain(DID);
  });

  it("orders newest first (updated_at, id as tiebreaker)", () => {
    expect(sql.toLowerCase()).toMatch(
      /order by\s+"drafts"\."updated_at"\s+desc,\s+"drafts"\."id"\s+desc/,
    );
  });

  it("caps the page at the per-writer maximum", () => {
    expect(sql.toLowerCase()).toContain("limit");
    expect([...params, sql].join(" ")).toContain(String(MAX_DRAFTS_PER_USER));
  });

  it("never ships content in the list (metadata only)", () => {
    expect(sql).not.toContain('"content"');
  });
});

describe("selectDraft / updateDraft / deleteDraft — ownership in the WHERE", () => {
  it("selectDraft binds id AND did", () => {
    const { sql, params } = selectDraft(db, DID, ID).toSQL();
    expectOwnershipBound(sql, params);
  });

  it("updateDraft binds id AND did, touches updated_at, and RETURNs the row", () => {
    const { sql, params } = updateDraft(db, DID, ID, {
      title: "t",
      content: "[]",
    }).toSQL();
    expectOwnershipBound(sql, params);
    expect(sql.toLowerCase()).toContain('update "drafts"');
    expect(sql).toContain('"updated_at"');
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("deleteDraft binds id AND did and RETURNs the row", () => {
    const { sql, params } = deleteDraft(db, DID, ID).toSQL();
    expectOwnershipBound(sql, params);
    expect(sql.toLowerCase()).toContain('delete from "drafts"');
    expect(sql.toLowerCase()).toContain("returning");
  });
});

describe("countDrafts / insertDraft — the create path", () => {
  it("countDrafts counts only the writer's rows", () => {
    const { sql, params } = countDrafts(db, DID).toSQL();
    expect(sql.toLowerCase()).toContain("count");
    expect(sql.toLowerCase()).toContain("where");
    expect(params).toContain(DID);
  });

  it("insertDraft writes the caller's row verbatim", () => {
    const { sql, params } = insertDraft(db, {
      id: ID,
      did: DID,
      title: "Hello",
      content: '[{"type":"paragraph"}]',
    }).toSQL();
    expect(sql.toLowerCase()).toContain('insert into "drafts"');
    expect(params).toContain(ID);
    expect(params).toContain(DID);
    expect(params).toContain("Hello");
    expect(params).toContain('[{"type":"paragraph"}]');
  });
});
