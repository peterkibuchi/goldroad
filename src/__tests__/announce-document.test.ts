// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared announce: the dashboard's button, the publish form's box and the
 * cron all come through here. The rule it exists to keep for the automatic
 * paths is that a post is never announced twice.
 */
const atproto = vi.hoisted(() => ({ getRecordEntry: vi.fn() }));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

import { announceDocument } from "../lib/announce-document";

const DID = "did:plc:fake2222222222writer2222";
const RKEY = "3lyk73wxnok2f";

function fakeRpc() {
  const posted: Array<{ nsid: string; input: Record<string, unknown> }> = [];
  const rpc = {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, input: options.input });
      return Promise.resolve({
        ok: true,
        status: 200,
        data:
          nsid === "com.atproto.repo.createRecord"
            ? {
                uri: `at://${DID}/app.bsky.feed.post/3lyk73wxpost1`,
                cid: "bafypost",
              }
            : {},
      });
    },
    // biome-ignore lint/suspicious/noExplicitAny: a narrow stand-in for the client
  } as any;
  return { rpc, posted };
}

function documentEntry(value: Record<string, unknown> = {}) {
  return {
    uri: `at://${DID}/site.standard.document/${RKEY}`,
    cid: "bafydoc",
    value: {
      $type: "site.standard.document",
      title: "The long way round",
      site: "https://trygoldroad.com/@writer.example",
      path: `/${RKEY}`,
      ...value,
    },
  };
}

const base = {
  did: DID,
  ident: "writer.example",
  pds: "https://pds.example.com",
  origin: "https://trygoldroad.com",
  rkey: RKEY,
} as const;

beforeEach(() => {
  atproto.getRecordEntry.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("announceDocument", () => {
  it("posts the card, then records it on the document without clobbering an edit", async () => {
    atproto.getRecordEntry.mockResolvedValue(documentEntry());
    const { rpc, posted } = fakeRpc();
    expect(await announceDocument({ rpc, ...base })).toEqual({
      ok: true,
      postRkey: "3lyk73wxpost1",
    });
    expect(posted.map((p) => p.input.collection)).toEqual([
      "app.bsky.feed.post",
      "site.standard.document",
    ]);
    expect(posted[1].input).toMatchObject({
      rkey: RKEY,
      swapRecord: "bafydoc",
      record: { bskyPostRef: { cid: "bafypost" } },
    });
  });

  it("thumbs the Bluesky card with the share card, else the cover", async () => {
    const blob = (cid: string, mimeType: string) => ({
      $type: "blob",
      ref: { $link: cid },
      mimeType,
      size: 61_234,
    });
    const card = blob("bafkreicardcardcardcardcardcardcardcard", "image/png");
    const cover = blob("bafkreicovercovercovercovercovercoverco", "image/jpeg");
    const thumbOf = async (fields: Record<string, unknown>) => {
      atproto.getRecordEntry.mockResolvedValue(documentEntry(fields));
      const { rpc, posted } = fakeRpc();
      await announceDocument({ rpc, ...base });
      const post = posted[0].input.record as {
        embed?: { external?: { thumb?: unknown } };
      };
      return post.embed?.external?.thumb;
    };
    expect(
      await thumbOf({ goldroadShareCard: card, coverImage: cover }),
    ).toEqual(card);
    expect(await thumbOf({ coverImage: cover })).toEqual(cover);
  });

  it("refuses an announced post when asked to announce only once", async () => {
    atproto.getRecordEntry.mockResolvedValue(
      documentEntry({ bskyPostRef: { uri: "at://x/y/z", cid: "bafyold" } }),
    );
    const { rpc, posted } = fakeRpc();
    expect(await announceDocument({ rpc, ...base, onlyOnce: true })).toEqual({
      ok: false,
      code: "already_announced",
    });
    expect(posted).toEqual([]);
  });

  it("lets the dashboard announce again, deliberately", async () => {
    atproto.getRecordEntry.mockResolvedValue(
      documentEntry({ bskyPostRef: { uri: "at://x/y/z", cid: "bafyold" } }),
    );
    const { rpc, posted } = fakeRpc();
    expect((await announceDocument({ rpc, ...base })).ok).toBe(true);
    expect(posted[0].input.collection).toBe("app.bsky.feed.post");
  });

  it("reports a document it can't read, and posts nothing", async () => {
    atproto.getRecordEntry.mockRejectedValue(new Error("404"));
    const { rpc, posted } = fakeRpc();
    expect(await announceDocument({ rpc, ...base, onlyOnce: true })).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(posted).toEqual([]);
  });
});
