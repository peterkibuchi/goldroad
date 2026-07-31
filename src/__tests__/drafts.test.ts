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
      dek: "a subtitle",
      content: "[]",
    }).toSQL();
    expectOwnershipBound(sql, params);
    expect(sql.toLowerCase()).toContain('update "drafts"');
    expect(sql).toContain('"updated_at"');
    // The subtitle is written on every save, so clearing it clears the column.
    expect(sql).toContain('"dek"');
    expect(params).toContain("a subtitle");
    expect(sql.toLowerCase()).toContain("returning");
  });

  it("updateDraft writes the markdown projection when it is given one", () => {
    const { sql, params } = updateDraft(db, DID, ID, {
      title: "t",
      dek: "",
      content: "[]",
      markdown: "the words",
    }).toSQL();
    expect(sql).toContain('"markdown"');
    expect(params).toContain("the words");
  });

  it("updateDraft LEAVES the projection alone when markdown is undefined", () => {
    // The single most consequential line in this file: the projection is the
    // only rendering of a document a cron can publish. A save that simply
    // didn't send one (an old tab, a partial client) must not be able to blank
    // it — that would turn a scheduled post into an empty one.
    const { sql } = updateDraft(db, DID, ID, {
      title: "t",
      dek: "",
      content: "[]",
    }).toSQL();
    expect(sql).not.toContain('"markdown"');
  });

  it("updateDraft LEAVES the image references alone when they aren't sent", () => {
    // The store the browser keeps them in is per-editor-session, so a resumed
    // draft sends none. Blanking them would publish a post whose own pictures
    // are broken — a PDS only serves a blob some record references.
    const { sql } = updateDraft(db, DID, ID, {
      title: "t",
      dek: "",
      content: "[]",
      markdown: "the words",
    }).toSQL();
    expect(sql).not.toContain('"inline_images"');
  });

  it("updateDraft writes the image references when a session uploaded some", () => {
    const { sql, params } = updateDraft(db, DID, ID, {
      title: "t",
      dek: "",
      content: "[]",
      markdown: "the words",
      inlineImages: '[{"$type":"blob"}]',
    }).toSQL();
    expect(sql).toContain('"inline_images"');
    expect(params).toContain('[{"$type":"blob"}]');
  });

  it("updateDraft still clears the projection when explicitly emptied", () => {
    const { sql, params } = updateDraft(db, DID, ID, {
      title: "t",
      dek: "",
      content: "[]",
      markdown: "",
    }).toSQL();
    expect(sql).toContain('"markdown"');
    expect(params).toContain("");
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
      dek: "A subtitle",
      content: '[{"type":"paragraph"}]',
      markdown: "Hello\n\nSome words.",
    }).toSQL();
    expect(sql.toLowerCase()).toContain('insert into "drafts"');
    expect(params).toContain("Hello\n\nSome words.");
    expect(params).toContain(ID);
    expect(params).toContain(DID);
    expect(params).toContain("Hello");
    expect(params).toContain("A subtitle");
    expect(params).toContain('[{"type":"paragraph"}]');
  });
});
