// @vitest-environment node
import { describe, expect, it } from "vitest";

import { rkeyFromUri } from "../lib/atproto";
import {
  findSubscription,
  isAtUri,
  SUBSCRIPTION_COLLECTION,
  subscribesTo,
  subscriptionRecord,
} from "../lib/subscription";

const PUB = "at://did:plc:writer/site.standard.publication/3lyk73wxnok2f";
const OTHER = "at://did:plc:writer/site.standard.publication/other000000";

describe("subscriptionRecord — what lands in the reader's own repo", () => {
  it("carries the collection, the publication and a date", () => {
    const record = subscriptionRecord(PUB, "2026-07-31T09:00:00.000Z");
    expect(record.$type).toBe(SUBSCRIPTION_COLLECTION);
    expect(record.publication).toBe(PUB);
    // Optional in the lexicon; always set, because a subscription with no date
    // cannot be ordered and "when did this reader arrive" is the question a
    // writer will eventually want answered.
    expect(record.createdAt).toBe("2026-07-31T09:00:00.000Z");
  });

  it("names the collection exactly once, in one place", () => {
    expect(SUBSCRIPTION_COLLECTION).toBe("site.standard.graph.subscription");
  });
});

describe("subscribesTo — reading a record off any repo, including a stranger's", () => {
  it("matches the publication it points at", () => {
    expect(subscribesTo({ publication: PUB }, PUB)).toBe(true);
  });

  it("does not match a different publication", () => {
    expect(subscribesTo({ publication: OTHER }, PUB)).toBe(false);
  });

  it("treats anything malformed as simply not a match", () => {
    // Same "invalid means absent" rule parseTheme follows — these arrive from
    // arbitrary PDSes and a hostile one is not a special case.
    for (const record of [
      null,
      undefined,
      "at://not/an/object",
      42,
      {},
      { publication: null },
      { publication: 42 },
      { publication: "" },
      { publication: "https://example.com/feed" },
      { publication: "did:plc:writer" },
    ]) {
      expect(subscribesTo(record, PUB)).toBe(false);
    }
  });
});

describe("isAtUri", () => {
  it("accepts a record URI", () => {
    expect(isAtUri(PUB)).toBe(true);
  });

  it("rejects what could not address a record", () => {
    for (const value of [
      "https://example.com",
      "at://",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isAtUri(value)).toBe(false);
    }
  });
});

describe("findSubscription — is the button on, and what do we delete", () => {
  const rows = [
    {
      uri: "at://did:plc:reader/site.standard.graph.subscription/aaa",
      value: { publication: OTHER },
    },
    {
      uri: "at://did:plc:reader/site.standard.graph.subscription/bbb",
      value: { publication: PUB },
    },
  ];

  it("returns the rkey of the matching subscription, because unsubscribing needs it", () => {
    expect(findSubscription(rows, PUB, rkeyFromUri)).toBe("bbb");
  });

  it("returns null when the reader has not subscribed to this one", () => {
    expect(findSubscription([rows[0]], PUB, rkeyFromUri)).toBeNull();
  });

  it("returns null for an empty repo", () => {
    expect(findSubscription([], PUB, rkeyFromUri)).toBeNull();
  });

  it("refuses a key taken from a malformed URI", () => {
    // rkeyFromUri reads the last path segment, which for a malformed uri is the
    // whole string — and that string can satisfy the rkey grammar. Without a
    // check we would hand back a plausible key pointing at nothing we meant.
    expect(
      findSubscription(
        [{ uri: "not-an-at-uri", value: { publication: PUB } }],
        PUB,
        rkeyFromUri,
      ),
    ).toBeNull();
  });

  it("refuses a key from a URI in some other collection", () => {
    // The record matched on content, but its address says it is not a
    // subscription. Deleting by that key would be deleting the wrong thing.
    expect(
      findSubscription(
        [
          {
            uri: "at://did:plc:reader/site.standard.document/ccc",
            value: { publication: PUB },
          },
        ],
        PUB,
        rkeyFromUri,
      ),
    ).toBeNull();
  });
});
