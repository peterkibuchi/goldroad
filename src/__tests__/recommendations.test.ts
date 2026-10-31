// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as atproto from "~/lib/atproto";
import * as moderation from "~/lib/moderation";

/**
 * Writer-curated recommendations: how the list is stored on the writer's
 * publication record (`goldroadRecommendations`, a permanent field name),
 * how what a writer types becomes an entry, and how the page resolves each
 * entry without letting one slow server hold it up.
 */

const ME = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const FRIEND = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const FRIEND_PUB = `at://${FRIEND}/site.standard.publication/3lyk73wxnok2f`;

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveReaderPds: vi.fn(async () => "https://pds.example"),
  resolveHandleToDid: vi.fn(),
  getRecord: vi.fn(),
  listRecords: vi.fn(),
  readWellKnownPublication: vi.fn(async () => null),
}));
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  hiddenSubjects: vi.fn(async () => new Set<string>()),
}));

import { visibleRecommendationCards } from "../lib/recommendation-cards";
import {
  MAX_RECOMMENDATIONS,
  recommendationsField,
  recommendationUris,
  resolveRecommendationInput,
  resolveRecommendations,
  withRecommendations,
} from "../lib/recommendations";

const ORIGINS = ["https://trygoldroad.com"];

beforeEach(() => {
  vi.mocked(atproto.getRecord).mockReset();
  vi.mocked(atproto.listRecords).mockReset();
  vi.mocked(atproto.resolveHandleToDid).mockReset();
  vi.mocked(atproto.readWellKnownPublication).mockResolvedValue(null);
});

describe("the stored list — goldroadRecommendations", () => {
  it("round-trips through the record in the writer's order", () => {
    const uris = [FRIEND_PUB, "https://example.com/blog"];
    const record = withRecommendations(
      {
        name: "The Long Way",
        url: "https://trygoldroad.com/@me.example",
        basicTheme: { $type: "site.standard.theme.basic" },
      },
      uris,
    ) as Record<string, unknown>;
    expect(record.goldroadRecommendations).toEqual([
      { uri: FRIEND_PUB },
      { uri: "https://example.com/blog" },
    ]);
    // Every other field survives the write.
    expect(record.basicTheme).toEqual({ $type: "site.standard.theme.basic" });
    expect(recommendationUris(record.goldroadRecommendations)).toEqual(uris);
  });

  it("removes the field entirely when the list is emptied", () => {
    const record = withRecommendations(
      {
        name: "The Long Way",
        url: "https://trygoldroad.com/@me.example",
        ...({ goldroadRecommendations: [{ uri: FRIEND_PUB }] } as object),
      },
      [],
    );
    expect(JSON.stringify(record)).not.toContain("goldroadRecommendations");
  });

  it("reads an untrusted field: junk dropped, duplicates collapsed, six at most", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      uri: `https://site${i}.example`,
    }));
    expect(
      recommendationUris([
        { uri: FRIEND_PUB },
        { uri: FRIEND_PUB },
        { uri: "http://plain.example" },
        { uri: "javascript:alert(1)" },
        { uri: `at://${FRIEND}/site.standard.document/3lyk73wxnok2f` },
        "https://bare-string.example",
        null,
        ...many,
      ]),
    ).toEqual([
      FRIEND_PUB,
      ...many.slice(0, MAX_RECOMMENDATIONS - 1).map((m) => m.uri),
    ]);
    expect(recommendationUris("not a list")).toEqual([]);
  });

  it("builds no field for an empty list", () => {
    expect(recommendationsField([])).toBeUndefined();
  });
});

describe("resolveRecommendations — what the page shows", () => {
  it("shows a publication's name, description and own address", async () => {
    vi.mocked(atproto.getRecord).mockResolvedValue({
      name: "Friend's Letters",
      description: "Weekly notes.",
      url: "https://friend.leaflet.pub",
    });
    const [card] = await resolveRecommendations([FRIEND_PUB]);
    expect(card).toEqual({
      uri: FRIEND_PUB,
      name: "Friend's Letters",
      description: "Weekly notes.",
      href: "https://friend.leaflet.pub",
      host: "friend.leaflet.pub",
    });
  });

  it("shows a plain website by its address, without a network call", async () => {
    const [card] = await resolveRecommendations([
      "https://www.example.com/blog/",
    ]);
    expect(card).toMatchObject({
      name: "example.com/blog",
      description: null,
      href: "https://www.example.com/blog/",
    });
    expect(atproto.getRecord).not.toHaveBeenCalled();
  });

  it("leaves out an entry whose record can't be read", async () => {
    vi.mocked(atproto.getRecord).mockRejectedValue(
      new atproto.NotFoundError("gone"),
    );
    expect(await resolveRecommendations([FRIEND_PUB])).toEqual([null]);
  });

  it("leaves out an entry whose server is slow, and keeps the rest", async () => {
    vi.mocked(atproto.getRecord).mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const cards = await resolveRecommendations(
      [FRIEND_PUB, "https://example.com"],
      30,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cards[0]).toBeNull();
    expect(cards[1]?.name).toBe("example.com");
    // The record read is told the same deadline, so it isn't left open.
    expect(vi.mocked(atproto.getRecord).mock.calls[0]?.[4]).toEqual({
      timeoutMs: 30,
    });
  });

  it("leaves out a publication or author taken down here", async () => {
    vi.mocked(moderation.hiddenSubjects).mockResolvedValueOnce(
      new Set([FRIEND]),
    );
    const cards = await visibleRecommendationCards(
      {} as Parameters<typeof visibleRecommendationCards>[0],
      [FRIEND_PUB, "https://example.com"],
    );
    expect(cards.map((c) => c.uri)).toEqual(["https://example.com"]);
    expect(atproto.getRecord).not.toHaveBeenCalled();
  });
});

describe("resolveRecommendationInput — what a writer can paste", () => {
  function hasPublication() {
    vi.mocked(atproto.resolveHandleToDid).mockResolvedValue(FRIEND);
    vi.mocked(atproto.listRecords).mockResolvedValue([
      { uri: FRIEND_PUB, cid: "bafy", value: {} },
    ]);
  }

  it("takes a handle, with or without the @", async () => {
    hasPublication();
    for (const input of ["@friend.bsky.social", "friend.bsky.social"])
      expect(await resolveRecommendationInput(input, ORIGINS)).toEqual({
        ok: true,
        uri: FRIEND_PUB,
      });
  });

  it("takes a reading page here and a Bluesky profile link", async () => {
    hasPublication();
    for (const input of [
      "https://trygoldroad.com/@friend.bsky.social",
      "https://bsky.app/profile/friend.bsky.social",
    ])
      expect(await resolveRecommendationInput(input, ORIGINS)).toEqual({
        ok: true,
        uri: FRIEND_PUB,
      });
  });

  it("says so when no account answers to an @handle", async () => {
    vi.mocked(atproto.resolveHandleToDid).mockRejectedValue(
      new atproto.NotFoundError("no such handle"),
    );
    expect(
      await resolveRecommendationInput("@nobody.example", ORIGINS),
    ).toEqual({ ok: false, problem: "no_account" });
  });

  it("says so when the account has no publication", async () => {
    vi.mocked(atproto.resolveHandleToDid).mockResolvedValue(FRIEND);
    vi.mocked(atproto.listRecords).mockResolvedValue([]);
    expect(
      await resolveRecommendationInput("@friend.bsky.social", ORIGINS),
    ).toEqual({ ok: false, problem: "no_publication" });
  });

  it("stores a site's publication when the site claims it and the record agrees", async () => {
    vi.mocked(atproto.readWellKnownPublication).mockResolvedValue(FRIEND_PUB);
    vi.mocked(atproto.getRecord).mockResolvedValue({
      name: "Friend",
      url: "https://friend.leaflet.pub",
    });
    expect(
      await resolveRecommendationInput("https://friend.leaflet.pub/", ORIGINS),
    ).toEqual({ ok: true, uri: FRIEND_PUB });
  });

  it("keeps the address when a site claims a publication that names another", async () => {
    vi.mocked(atproto.readWellKnownPublication).mockResolvedValue(FRIEND_PUB);
    vi.mocked(atproto.getRecord).mockResolvedValue({
      name: "Friend",
      url: "https://someone-else.example",
    });
    expect(
      await resolveRecommendationInput("https://impostor.example", ORIGINS),
    ).toEqual({ ok: true, uri: "https://impostor.example/" });
  });

  it("keeps any other https address as a website", async () => {
    // A bare domain is also a valid handle: tried as one first.
    vi.mocked(atproto.resolveHandleToDid).mockRejectedValue(
      new atproto.NotFoundError("no such handle"),
    );
    expect(
      await resolveRecommendationInput("example.substack.com", ORIGINS),
    ).toEqual({ ok: true, uri: "https://example.substack.com/" });
  });

  it("takes a bare domain as a website when it leads to no publication", async () => {
    // nytimes.com-style: a real handle, but no publication behind it.
    vi.mocked(atproto.resolveHandleToDid).mockResolvedValue(FRIEND);
    vi.mocked(atproto.listRecords).mockResolvedValue([]);
    expect(await resolveRecommendationInput("news.example", ORIGINS)).toEqual({
      ok: true,
      uri: "https://news.example/",
    });
  });

  it("keeps a profile link with a malformed escape as an address instead of failing", async () => {
    expect(
      await resolveRecommendationInput("https://trygoldroad.com/@%E0", ORIGINS),
    ).toEqual({ ok: true, uri: "https://trygoldroad.com/@%E0" });
  });

  it("refuses what isn't an address, a handle or a publication", async () => {
    for (const input of [
      "not an address",
      "http://plain.example",
      `at://${FRIEND}/site.standard.document/3lyk73wxnok2f`,
      "javascript:alert(1)",
    ])
      expect(await resolveRecommendationInput(input, ORIGINS)).toEqual({
        ok: false,
        problem: "unrecognised",
      });
    // ME is unused otherwise; a DID alone isn't a handle or an address.
    expect((await resolveRecommendationInput(ME, ORIGINS)).ok).toBe(false);
  });
});
