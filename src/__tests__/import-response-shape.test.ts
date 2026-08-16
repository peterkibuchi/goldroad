// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * The /import page walks its own endpoints' JSON straight into
 * `items.filter(…)`, `item.title.trim()` and `slice(0, draftSlotsRemaining)`.
 * That is fine right up until the answer isn't the one we expect — a drifted
 * server, an intercepting proxy, a captive portal with opinions — and then a
 * writer partway through importing an archive gets an undefined-property crash
 * instead of the notice this page already knows how to show.
 */
import {
  errorCodeOf,
  isFeedBody,
  isOkBody,
  isStatusBody,
} from "~/routes/import";

const item = {
  guid: "https://example.com/p/1",
  guidHash: "a".repeat(64),
  link: "https://example.com/p/1",
  title: "A post",
  publishedAt: "2026-07-01T00:00:00.000Z",
  contentHtml: "<p>words</p>",
  preview: false,
  alreadyImported: false,
};

const feedBody = {
  ok: true,
  feed: { title: "The publication", url: "https://example.com" },
  totalItems: 1,
  draftSlotsRemaining: 9,
  items: [item],
};

const statusBody = {
  ok: true,
  draftSlotsRemaining: 9,
  alreadyImported: [item.guidHash],
};

describe("isOkBody / errorCodeOf", () => {
  it("recognizes a success and a refusal", () => {
    expect(isOkBody({ ok: true })).toBe(true);
    expect(isOkBody({ ok: false, error: "rate_limited" })).toBe(false);
    expect(errorCodeOf({ ok: false, error: "rate_limited" })).toBe(
      "rate_limited",
    );
  });

  it("survives the bodies that are not objects at all", () => {
    for (const body of [null, undefined, 42, "ok", [], true]) {
      expect(isOkBody(body)).toBe(false);
      expect(errorCodeOf(body)).toBeNull();
    }
  });
});

describe("the /api/import feed body", () => {
  it("accepts the shape the endpoint promises", () => {
    expect(isFeedBody(feedBody)).toBe(true);
    // A feed with nothing in it is a real answer, not a drift.
    expect(isFeedBody({ ...feedBody, items: [], totalItems: 0 })).toBe(true);
  });

  it("rejects a success that is missing what the picker reads", () => {
    expect(isFeedBody({ ...feedBody, items: undefined })).toBe(false);
    expect(isFeedBody({ ...feedBody, draftSlotsRemaining: null })).toBe(false);
    expect(isFeedBody({ ...feedBody, feed: undefined })).toBe(false);
    expect(isFeedBody({ ...feedBody, totalItems: "9" })).toBe(false);
  });

  it("rejects a success whose items are not items", () => {
    for (const bad of [
      null,
      "a post",
      { ...item, title: undefined },
      { ...item, contentHtml: 42 },
      { ...item, guidHash: null },
      { ...item, preview: "no" },
      { ...item, link: 7 },
    ]) {
      expect(isFeedBody({ ...feedBody, items: [bad] })).toBe(false);
    }
  });

  it("rejects a refusal and a body that is not one of ours", () => {
    expect(isFeedBody({ ok: false, error: "not_a_feed" })).toBe(false);
    expect(isFeedBody("<html>captive portal</html>")).toBe(false);
    expect(isFeedBody(null)).toBe(false);
  });
});

describe("the /api/import/status body", () => {
  it("accepts the shape the endpoint promises", () => {
    expect(isStatusBody(statusBody)).toBe(true);
    expect(isStatusBody({ ...statusBody, alreadyImported: [] })).toBe(true);
  });

  it("rejects a body the picker would silently mis-cap on", () => {
    // Absent headroom used to reach `slice(0, undefined)`, which selects
    // EVERYTHING — the opposite of the cap it was meant to apply.
    expect(
      isStatusBody({ ...statusBody, draftSlotsRemaining: undefined }),
    ).toBe(false);
    expect(isStatusBody({ ...statusBody, alreadyImported: undefined })).toBe(
      false,
    );
    expect(isStatusBody({ ...statusBody, alreadyImported: [1, 2] })).toBe(
      false,
    );
    expect(isStatusBody({ ok: false, error: "not_signed_in" })).toBe(false);
    expect(isStatusBody(null)).toBe(false);
  });
});
