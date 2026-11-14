// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildPublicationRecord,
  documentAtUri,
  pinnedPostRkey,
} from "../lib/publish";

/**
 * The "Start here" pin as it is stored: `goldroadPinnedPost` on the writer's
 * own publication record, holding a document AT-URI. The field name is
 * permanent, so these cases pin its spelling as much as its behaviour.
 */

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const URL = "https://trygoldroad.com/@writer.example";

describe("pinnedPostRkey — reading an untrusted pin", () => {
  it("accepts a document in the publication's own repo", () => {
    expect(pinnedPostRkey(documentAtUri(DID, "3lyk73wxnok2f"), DID)).toBe(
      "3lyk73wxnok2f",
    );
  });

  it("ignores another writer's post", () => {
    expect(
      pinnedPostRkey(documentAtUri(OTHER, "3lyk73wxnok2f"), DID),
    ).toBeNull();
  });

  it("ignores a record that isn't a document", () => {
    expect(
      pinnedPostRkey(
        `at://${DID}/site.standard.publication/3lyk73wxnok2f`,
        DID,
      ),
    ).toBeNull();
  });

  it("ignores anything that isn't an AT-URI string", () => {
    for (const value of [
      undefined,
      null,
      42,
      { uri: documentAtUri(DID, "3lyk73wxnok2f") },
      "https://example.com/post",
      `at://${DID}/site.standard.document/`,
      `at://${DID}/site.standard.document/a/b`,
    ])
      expect(pinnedPostRkey(value, DID)).toBeNull();
  });
});

describe("buildPublicationRecord — the pin round trip", () => {
  const pin = documentAtUri(DID, "3lyk73wxnok2f");

  it("writes the pin under goldroadPinnedPost", () => {
    const record = buildPublicationRecord({
      name: "The Long Way",
      url: URL,
      pinnedPost: pin,
    });
    expect((record as Record<string, unknown>).goldroadPinnedPost).toBe(pin);
    // And reads back through the same door a reader's page uses.
    expect(
      pinnedPostRkey(
        (record as Record<string, unknown>).goldroadPinnedPost,
        DID,
      ),
    ).toBe("3lyk73wxnok2f");
  });

  it("removes it on null and keeps it on undefined", () => {
    const existing = { name: "Old", url: URL, goldroadPinnedPost: pin };
    const removed = buildPublicationRecord(
      { name: "The Long Way", url: URL, pinnedPost: null },
      existing,
    ) as Record<string, unknown>;
    expect(removed.goldroadPinnedPost).toBeUndefined();
    // Gone from the serialized record, not stored as null.
    expect(JSON.stringify(removed)).not.toContain("goldroadPinnedPost");

    const kept = buildPublicationRecord(
      { name: "The Long Way", url: URL },
      existing,
    ) as Record<string, unknown>;
    expect(kept.goldroadPinnedPost).toBe(pin);
  });
});
