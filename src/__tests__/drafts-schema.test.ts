// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  draftPayload,
  isDraftId,
  MAX_DRAFT_BODY_BYTES,
  MAX_DRAFTS_PER_USER,
} from "../lib/drafts-schema";
import { MAX_TITLE_LENGTH } from "../lib/publish";

describe("draftPayload — the /api/drafts upsert body", () => {
  const blocks = [{ type: "paragraph", content: [] }];

  it("accepts a create payload (no id)", () => {
    const parsed = draftPayload.safeParse({ title: "Hello", content: blocks });
    expect(parsed.success).toBe(true);
  });

  it("accepts an update payload (UUID id) and an empty title", () => {
    const parsed = draftPayload.safeParse({
      id: crypto.randomUUID(),
      title: "",
      content: blocks,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-UUID id (ids never reach a query unvalidated)", () => {
    for (const id of ["abc", "1; DROP TABLE drafts", "../../etc", ""]) {
      expect(
        draftPayload.safeParse({ id, title: "", content: blocks }).success,
      ).toBe(false);
    }
  });

  it("rejects missing or non-array content — blocks are an array, always", () => {
    expect(draftPayload.safeParse({ title: "x" }).success).toBe(false);
    expect(
      draftPayload.safeParse({ title: "x", content: "not-blocks" }).success,
    ).toBe(false);
    expect(
      draftPayload.safeParse({ title: "x", content: { type: "doc" } }).success,
    ).toBe(false);
  });

  it("rejects a missing title and caps its length at the publish cap", () => {
    expect(draftPayload.safeParse({ content: blocks }).success).toBe(false);
    expect(
      draftPayload.safeParse({
        title: "a".repeat(MAX_TITLE_LENGTH + 1),
        content: blocks,
      }).success,
    ).toBe(false);
    expect(
      draftPayload.safeParse({
        title: "a".repeat(MAX_TITLE_LENGTH),
        content: blocks,
      }).success,
    ).toBe(true);
  });
});

describe("isDraftId", () => {
  it("accepts crypto.randomUUID output", () => {
    expect(isDraftId(crypto.randomUUID())).toBe(true);
  });

  it("rejects junk, near-misses, and injection shapes", () => {
    for (const bad of [
      "",
      "abc",
      "00000000-0000-0000-0000-00000000000", // one short
      "00000000-0000-0000-0000-0000000000000", // one long
      "ZZZZZZZZ-0000-0000-0000-000000000000", // non-hex
      "' OR 1=1 --",
    ]) {
      expect(isDraftId(bad)).toBe(false);
    }
  });
});

describe("the drafts caps (pinned contract)", () => {
  it("bounds the request body at 512 KiB and drafts at 50 per writer", () => {
    // 512 KiB, up from 256: a save now carries the markdown projection as well
    // as the blocks, so the same words travel twice in one request. Still a
    // bound — the per-writer draft cap is what keeps the product honest.
    expect(MAX_DRAFT_BODY_BYTES).toBe(512 * 1024);
    expect(MAX_DRAFTS_PER_USER).toBe(50);
  });
});
