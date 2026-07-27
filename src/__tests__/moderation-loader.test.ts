// @vitest-environment node
import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

import { checkHidden } from "~/lib/moderation";

/**
 * The launch-blocking assertion: a hidden subject makes the reader loader throw
 * a takedown-marked notFound (→ 404 + ContentUnavailable), not the writer's
 * content — AND the loader hands checkHidden the OBJECT shape it expects.
 *
 * COVERAGE HONESTY: this exercises the loader wiring and the CALLER-SIDE input
 * shape (the `{did, atUri}` object — an array here silently serialized to `[]`
 * over the GET transport and disabled takedowns, so the shape is now pinned on
 * both ends: here + the hiddenSubjectsFromInput unit test). It does NOT drive
 * the real GET server-fn HTTP round-trip — that isn't exercisable under vitest
 * ("No Start context in AsyncLocalStorage", probed), so it's covered instead by
 * a manual seeded-D1 end-to-end check and the opt-in live-takedown canary
 * (CANARY_SEED=1). checkHidden is mocked to true; resolveHandleToDid
 * is mocked so the loader reaches the check.
 */
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  checkHidden: vi.fn(async () => true),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveHandleToDid: vi.fn(async () => "did:plc:ukp7pzzht32uigg6bg4vxr5t"),
}));

import { loadDocument } from "../components/document-article";

describe("reader takedown wiring", () => {
  it("throws a hidden-marked notFound and calls checkHidden with the {did, atUri} object", async () => {
    let thrown: unknown;
    try {
      await loadDocument("writer.example", "3lyk73wxnok2f");
    } catch (err) {
      thrown = err;
    }
    expect(isNotFound(thrown)).toBe(true);
    expect((thrown as { data?: { hidden?: boolean } }).data?.hidden).toBe(true);

    // Pin the caller-side contract: an OBJECT of strings, never an array.
    expect(checkHidden).toHaveBeenCalledWith({
      data: {
        did: "did:plc:ukp7pzzht32uigg6bg4vxr5t",
        atUri:
          "at://did:plc:ukp7pzzht32uigg6bg4vxr5t/site.standard.document/3lyk73wxnok2f",
      },
    });
  });
});
