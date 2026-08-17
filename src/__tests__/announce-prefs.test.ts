// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  AUTO_ANNOUNCE_WINDOW_MS,
  MAX_AUTO_ANNOUNCES_PER_HOUR,
} from "../lib/announce";
import {
  announceDefaultFor,
  consumeAutoAnnounceBudget,
  selectWriterPrefs,
  setAutoAnnounce,
  withinAutoAnnounceBudget,
} from "../lib/announce-prefs";

/**
 * The announce preference and its budget, pinned via `.toSQL()` without a live
 * D1 — the same way this codebase verifies every other store (drafts.test.ts,
 * rights-store.test.ts, scheduled-posts-store.test.ts).
 *
 * Two things here are load-bearing beyond "the query runs":
 *
 *  1. AN ABSENT ROW MEANS ON. Most writers will never open the setting, so the
 *     absence of a row is the state the publish path sees most often — and if
 *     that ever reads as "off", announcing quietly stops working for everybody
 *     who never touched it, with nothing failing anywhere.
 *  2. THE BUDGET IS ONE STATEMENT. A read followed by a write has a window in
 *     it, and two isolates publishing for the same writer in the same second
 *     would both read "nothing spent yet" — which is exactly the burst the cap
 *     exists to prevent.
 */
// biome-ignore lint/suspicious/noExplicitAny: no live D1 — .toSQL() only
const db = drizzle({} as any);
const DID = "did:plc:fake2222222222writer2222";
const NOW = new Date("2026-08-17T09:00:00.000Z");

describe("announceDefaultFor — the reading of an absent row", () => {
  it("is ON when the writer has no row", () => {
    expect(announceDefaultFor(undefined)).toBe(true);
  });

  it("is whatever the row says once there is one", () => {
    expect(announceDefaultFor({ autoAnnounce: false })).toBe(false);
    expect(announceDefaultFor({ autoAnnounce: true })).toBe(true);
  });
});

describe("selectWriterPrefs", () => {
  it("reads one row, bound to the writer's DID", () => {
    const { sql, params } = selectWriterPrefs(db, DID).toSQL();
    expect(sql.toLowerCase()).toContain('from "writer_prefs"');
    expect(sql).toContain('"did" = ?');
    expect(params).toContain(DID);
    expect(sql.toLowerCase()).toContain("limit");
  });
});

describe("setAutoAnnounce", () => {
  it("upserts, because the first thing a writer stores may be 'off'", () => {
    const { sql, params } = setAutoAnnounce(db, DID, false, NOW).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('insert into "writer_prefs"');
    expect(lower).toContain("on conflict");
    expect(params).toContain(DID);
  });

  it("leaves the budget alone — a preference change is not an announce", () => {
    // Resetting the counter here would make the toggle a way to refill the
    // budget: off, on, and five more cards.
    const { sql } = setAutoAnnounce(db, DID, true, NOW).toSQL();
    const update = sql.slice(sql.toLowerCase().indexOf("on conflict"));
    expect(update).not.toContain("auto_count");
    expect(update).not.toContain("auto_window_at");
  });
});

describe("consumeAutoAnnounceBudget", () => {
  it("spends a slot in ONE statement, and reports the new total", () => {
    const { sql } = consumeAutoAnnounceBudget(db, DID, NOW).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('insert into "writer_prefs"');
    expect(lower).toContain("on conflict");
    // The caller decides against the cap from what this hands back.
    expect(lower).toContain("returning");
    expect(sql).toContain('"auto_count"');
  });

  it("resets the window when the stored one has aged out, and adds to it otherwise", () => {
    const { sql, params } = consumeAutoAnnounceBudget(db, DID, NOW).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain("case when");
    expect(lower).toContain('"auto_window_at" is null');
    // The window's own boundary is bound as a parameter, so "an hour ago" is
    // computed once here rather than in SQLite's date functions.
    expect(params).toContain(NOW.getTime() - AUTO_ANNOUNCE_WINDOW_MS);
    expect(params).toContain(NOW.getTime());
    // Bare column references inside ON CONFLICT DO UPDATE are the EXISTING
    // row's values in SQLite, which is what makes this an increment rather than
    // an overwrite.
    expect(sql).toContain('"auto_count" + 1');
  });

  it("creates the row as a writer whose setting is on", () => {
    // Nothing else could have reached this statement: an announce is being
    // spent, so the answer to "does this writer announce" was already yes.
    const { params } = consumeAutoAnnounceBudget(db, DID, NOW).toSQL();
    expect(params).toContain(DID);
    expect(params).toContain(1);
  });
});

describe("withinAutoAnnounceBudget", () => {
  it("allows the cap and refuses the one past it", () => {
    expect(withinAutoAnnounceBudget(1)).toBe(true);
    expect(withinAutoAnnounceBudget(MAX_AUTO_ANNOUNCES_PER_HOUR)).toBe(true);
    expect(withinAutoAnnounceBudget(MAX_AUTO_ANNOUNCES_PER_HOUR + 1)).toBe(
      false,
    );
  });

  it("keeps refusing once a writer is over it", () => {
    // The counter climbs even on refused attempts (documented on the query):
    // there is no second CASE arm to hold a number whose only meaning is
    // "already too many", and the window rolling is what clears it.
    expect(withinAutoAnnounceBudget(MAX_AUTO_ANNOUNCES_PER_HOUR + 40)).toBe(
      false,
    );
  });
});
