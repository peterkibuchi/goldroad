// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  anyHidden,
  hiddenSubjects,
  hiddenSubjectsFromInput,
  recordAtUri,
} from "../lib/moderation";

/** Chainable drizzle stand-in: select().from().where().get() → `row`. */
function mockDb(row: unknown) {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    get: vi.fn(async () => row),
  };
  return chain;
}

describe("recordAtUri", () => {
  it("composes an AT-URI from did/collection/rkey", () => {
    expect(
      recordAtUri("did:plc:abc", "site.standard.document", "3lyk73wxnok2f"),
    ).toBe("at://did:plc:abc/site.standard.document/3lyk73wxnok2f");
  });
});

// This is the shape the checkHidden GET server fn actually receives. It MUST be
// an object of strings — an earlier array-typed input silently produced [] over
// the GET transport, which disabled the reader takedown. Pin the contract.
describe("hiddenSubjectsFromInput", () => {
  it("keeps did + atUri from an object input", () => {
    expect(
      hiddenSubjectsFromInput({ did: "did:plc:abc", atUri: "at://x/c/r" }),
    ).toEqual(["did:plc:abc", "at://x/c/r"]);
  });

  it("drops absent/non-string fields", () => {
    expect(hiddenSubjectsFromInput({ did: "did:plc:abc" })).toEqual([
      "did:plc:abc",
    ]);
    expect(hiddenSubjectsFromInput({ did: 123, atUri: null })).toEqual([]);
    expect(hiddenSubjectsFromInput({})).toEqual([]);
  });
});

describe("anyHidden", () => {
  it("is true when a subject matches a hide-list row", async () => {
    const db = mockDb({ id: 1 });
    // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
    expect(await anyHidden(db as any, ["did:plc:abc"])).toBe(true);
    expect(db.get).toHaveBeenCalledTimes(1);
  });

  it("is false when nothing matches", async () => {
    const db = mockDb(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
    expect(await anyHidden(db as any, ["at://did:plc:abc/c/r"])).toBe(false);
  });

  it("short-circuits on empty / all-blank input without querying", async () => {
    const db = mockDb({ id: 1 });
    // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
    expect(await anyHidden(db as any, [])).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
    expect(await anyHidden(db as any, ["", ""])).toBe(false);
    expect(db.get).not.toHaveBeenCalled();
  });
});

/** Chainable drizzle stand-in: select().from().where().all() → `rows`. */
function mockDbAll(rows: unknown[]) {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    all: vi.fn(async () => rows),
  };
  return chain;
}

describe("hiddenSubjects", () => {
  it("returns exactly the matching subjects (the feed's per-item filter)", async () => {
    const db = mockDbAll([{ subject: "at://did:plc:abc/c/r1" }]);
    const hidden = await hiddenSubjects(
      // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
      db as any,
      ["did:plc:abc", "at://did:plc:abc/c/r1", "at://did:plc:abc/c/r2"],
    );
    expect(hidden).toEqual(new Set(["at://did:plc:abc/c/r1"]));
  });

  it("short-circuits on empty / all-blank input without querying", async () => {
    const db = mockDbAll([{ subject: "x" }]);
    // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
    expect(await hiddenSubjects(db as any, [])).toEqual(new Set());
    // biome-ignore lint/suspicious/noExplicitAny: chain stub stands in for drizzle
    expect(await hiddenSubjects(db as any, ["", ""])).toEqual(new Set());
    expect(db.all).not.toHaveBeenCalled();
  });
});
