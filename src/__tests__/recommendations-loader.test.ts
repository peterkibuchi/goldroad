// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as atproto from "~/lib/atproto";
import * as cards from "~/lib/recommendation-cards";

/**
 * When the publication page resolves recommendations, and that a failure to
 * resolve them never costs the page.
 */

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const FRIEND =
  "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/site.standard.publication/3lyk73wxnok2f";

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveReaderPds: vi.fn(async () => "https://pds.example"),
  refreshReaderPds: vi.fn(async () => null),
  listRecords: vi.fn(),
  listRecordsPage: vi.fn(async () => ({ records: [], cursor: null })),
}));
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  checkHidden: vi.fn(async () => false),
}));
vi.mock("~/lib/recommendation-cards", () => ({
  recommendationCards: vi.fn(async () => []),
}));

import { Route } from "../routes/@{$handle}.index";

type Options = {
  loader: (ctx: {
    params: { handle: string };
    deps: { cursor?: string; q?: string };
  }) => Promise<{ recommendations: unknown[]; posts: unknown[] }>;
};
const options = Route.options as unknown as Options;
const load = (deps: { cursor?: string } = {}) =>
  options.loader({ params: { handle: DID }, deps });

function publications(...values: Record<string, unknown>[]) {
  vi.mocked(atproto.listRecords).mockResolvedValue(
    values.map((value, i) => ({
      uri: `at://${DID}/site.standard.publication/3lyk73wxnok2${i}`,
      cid: "bafy",
      value,
    })),
  );
}

beforeEach(() => {
  vi.mocked(cards.recommendationCards).mockReset();
  vi.mocked(cards.recommendationCards).mockResolvedValue([]);
});

describe("publication loader — recommendations", () => {
  it("resolves the cleaned list from whichever publication carries one", async () => {
    publications(
      { name: "Elsewhere", url: "https://me.leaflet.pub" },
      {
        name: "The Long Way",
        url: "https://trygoldroad.com/@me.example",
        goldroadRecommendations: [
          { uri: FRIEND },
          { uri: "javascript:alert(1)" },
          { uri: "https://example.com" },
        ],
      },
    );
    const card = {
      uri: FRIEND,
      name: "Friend",
      description: null,
      href: "https://f.example",
      host: "f.example",
    };
    vi.mocked(cards.recommendationCards).mockResolvedValue([card]);
    const data = await load();
    expect(vi.mocked(cards.recommendationCards).mock.calls[0]?.[0]).toEqual({
      data: { uris: `${FRIEND}\nhttps://example.com` },
    });
    expect(data.recommendations).toEqual([card]);
  });

  it("reads only the record Settings writes, when there is one", async () => {
    publications(
      {
        name: "Elsewhere",
        url: "https://me.leaflet.pub",
        goldroadRecommendations: [{ uri: FRIEND }],
      },
      { name: "The Long Way", url: "https://trygoldroad.com/@me.example" },
    );
    // The writer's own record has no list (they cleared it), so none shows.
    expect((await load()).recommendations).toEqual([]);
    expect(cards.recommendationCards).not.toHaveBeenCalled();
  });

  it("costs nothing when there is no list", async () => {
    publications({ name: "The Long Way" });
    expect((await load()).recommendations).toEqual([]);
    expect(cards.recommendationCards).not.toHaveBeenCalled();
  });

  it("renders the page without them when resolving fails", async () => {
    publications({
      name: "The Long Way",
      goldroadRecommendations: [{ uri: FRIEND }],
    });
    vi.mocked(cards.recommendationCards).mockRejectedValue(new Error("boom"));
    const data = await load();
    expect(data.recommendations).toEqual([]);
    expect(data.posts).toEqual([]);
  });

  it("doesn't resolve them on an older page of the archive", async () => {
    publications({
      name: "The Long Way",
      goldroadRecommendations: [{ uri: FRIEND }],
    });
    expect((await load({ cursor: "abc" })).recommendations).toEqual([]);
    expect(cards.recommendationCards).not.toHaveBeenCalled();
  });
});
