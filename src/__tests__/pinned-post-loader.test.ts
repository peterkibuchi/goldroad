// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as atproto from "../lib/atproto";
import * as moderation from "../lib/moderation";

/**
 * Which pin the publication page shows. A pin is an extra on top of the
 * archive, so every way it can be wrong ends the same way: no "Start here",
 * and the rest of the page exactly as it would be without one.
 */

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const PIN_RKEY = "3lyk73wxnok2f";
const PIN = `at://${DID}/site.standard.document/${PIN_RKEY}`;

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveReaderPds: vi.fn(async () => "https://pds.example"),
  refreshReaderPds: vi.fn(async () => null),
  listRecords: vi.fn(),
  listRecordsPage: vi.fn(),
  getRecord: vi.fn(),
}));
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  checkHidden: vi.fn(async () => false),
}));

import { Route } from "../routes/@{$handle}.index";

type Options = {
  loader: (ctx: {
    params: { handle: string };
    deps: { cursor?: string; q?: string };
  }) => Promise<{ pinned: { rkey: string; title: string } | null }>;
};
const options = Route.options as unknown as Options;
const load = (deps: { cursor?: string } = {}) =>
  options.loader({ params: { handle: DID }, deps });

function doc(rkey: string, title: string) {
  return {
    uri: `at://${DID}/site.standard.document/${rkey}`,
    cid: "bafyreidoc",
    value: { title, publishedAt: "2026-01-05T00:00:00.000Z" },
  };
}

function pinning(value: unknown) {
  vi.mocked(atproto.listRecords).mockResolvedValue([
    {
      uri: `at://${DID}/site.standard.publication/3lyk73wxnok2a`,
      cid: "bafyreipub",
      value: { name: "The Long Way", goldroadPinnedPost: value },
    },
  ]);
}

beforeEach(() => {
  vi.mocked(atproto.getRecord).mockReset();
  vi.mocked(moderation.checkHidden).mockResolvedValue(false);
  vi.mocked(atproto.listRecordsPage).mockResolvedValue({
    records: [doc("3lzzzzzzzzzzz", "Newest"), doc(PIN_RKEY, "About me")],
    cursor: null,
  });
  pinning(PIN);
});

describe("publication loader — the Start here pin", () => {
  it("takes a recent pin from the listed page, with no extra read", async () => {
    const data = await load();
    expect(data.pinned?.title).toBe("About me");
    expect(atproto.getRecord).not.toHaveBeenCalled();
    expect(moderation.checkHidden).toHaveBeenLastCalledWith({
      data: { did: DID, atUri: PIN },
    });
  });

  it("reads an older pin from the writer's repo", async () => {
    vi.mocked(atproto.listRecordsPage).mockResolvedValue({
      records: [doc("3lzzzzzzzzzzz", "Newest")],
      cursor: null,
    });
    vi.mocked(atproto.getRecord).mockResolvedValue({ title: "From 2024" });
    const data = await load();
    expect(data.pinned).toMatchObject({ rkey: PIN_RKEY, title: "From 2024" });
    expect(vi.mocked(atproto.getRecord).mock.calls[0]).toEqual([
      "https://pds.example",
      DID,
      "site.standard.document",
      PIN_RKEY,
    ]);
  });

  it("ignores a pin whose post was deleted", async () => {
    vi.mocked(atproto.listRecordsPage).mockResolvedValue({
      records: [doc("3lzzzzzzzzzzz", "Newest")],
      cursor: null,
    });
    vi.mocked(atproto.getRecord).mockRejectedValue(
      new atproto.NotFoundError("gone"),
    );
    expect((await load()).pinned).toBeNull();
  });

  it("ignores a pin on another writer's post, without reading it", async () => {
    pinning(
      `at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/site.standard.document/${PIN_RKEY}`,
    );
    expect((await load()).pinned).toBeNull();
    expect(atproto.getRecord).not.toHaveBeenCalled();
  });

  it("ignores a pin on a post taken down here", async () => {
    vi.mocked(moderation.checkHidden).mockImplementation(async ({ data }) =>
      Boolean((data as { atUri?: string }).atUri),
    );
    expect((await load()).pinned).toBeNull();
  });

  it("reads the pin from a newer publication when the oldest is another app's", async () => {
    vi.mocked(atproto.listRecords).mockResolvedValue([
      {
        uri: `at://${DID}/site.standard.publication/3lyk73wxnok22`,
        cid: "bafyreileaflet",
        value: { name: "Elsewhere", url: "https://writer.leaflet.pub" },
      },
      {
        uri: `at://${DID}/site.standard.publication/3lyk73wxnok2a`,
        cid: "bafyreipub",
        value: {
          name: "The Long Way",
          url: "https://trygoldroad.com/@writer.example",
          goldroadPinnedPost: PIN,
        },
      },
    ]);
    expect((await load()).pinned?.title).toBe("About me");
  });

  it("reads only the record Settings writes, so unpinning there takes", async () => {
    vi.mocked(atproto.listRecords).mockResolvedValue([
      {
        uri: `at://${DID}/site.standard.publication/3lyk73wxnok22`,
        cid: "bafyreileaflet",
        value: {
          name: "Elsewhere",
          url: "https://writer.leaflet.pub",
          goldroadPinnedPost: PIN,
        },
      },
      {
        uri: `at://${DID}/site.standard.publication/3lyk73wxnok2a`,
        cid: "bafyreipub",
        value: {
          name: "The Long Way",
          url: "https://trygoldroad.com/@writer.example",
        },
      },
    ]);
    expect((await load()).pinned).toBeNull();
  });

  it("still shows the pin when the takedown check call itself fails", async () => {
    // Only the pin's check fails; the page's own author check is not this test's.
    vi.mocked(moderation.checkHidden).mockImplementation(async ({ data }) => {
      if ((data as { atUri?: string }).atUri) throw new Error("offline");
      return false;
    });
    expect((await load()).pinned?.title).toBe("About me");
  });

  it("shows no pin on an older page of the archive", async () => {
    expect((await load({ cursor: "abc" })).pinned).toBeNull();
  });
});
