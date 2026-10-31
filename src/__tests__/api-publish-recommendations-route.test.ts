// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * intent=recommendations on /api/publish: the list is written into the
 * writer's existing publication record, rebuilt from what the form kept plus
 * one new address, with every other field left as it was.
 */

const atproto = vi.hoisted(() => ({
  resolveDidIdentity: vi.fn(),
  listRecords: vi.fn(),
}));
vi.mock("~/lib/handle-history", () => ({
  recordWriterHandle: vi.fn(async () => {}),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));
const resolveInput = vi.hoisted(() => vi.fn());
vi.mock("~/lib/recommendations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/recommendations")>()),
  resolveRecommendationInput: resolveInput,
}));

const posted = vi.hoisted(
  () =>
    [] as Array<{ nsid: string; options: { input: Record<string, unknown> } }>,
);
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, options });
      return Promise.resolve({ ok: true, data: {} });
    }
  },
}));
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: () => ({ restore: () => Promise.resolve({}) }),
}));

const DID = "did:plc:fake2222222222writer2222";
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(DID),
}));

import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const FRIEND =
  "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/site.standard.publication/3lyk73wxnok2f";
const SITES = Array.from({ length: 6 }, (_, i) => `https://site${i}.example/`);

function publication(extra: Record<string, unknown> = {}) {
  return {
    uri: `at://${DID}/site.standard.publication/3lyk73wxnok2a`,
    cid: "bafyreipublication",
    value: {
      $type: "site.standard.publication",
      name: "The Long Way",
      url: "https://trygoldroad.com/@writer.example",
      basicTheme: { $type: "site.standard.theme.basic" },
      ...extra,
    },
  };
}

async function save(kept: string[], add = ""): Promise<Response> {
  const form = new FormData();
  form.append("intent", "recommendations");
  for (const uri of kept) form.append("recommendation", uri);
  if (add) form.append("add", add);
  return POST({
    request: new Request("https://trygoldroad.com/api/publish", {
      method: "POST",
      body: form,
    }),
  });
}

function written(): Record<string, unknown> | null {
  const put = posted.find((p) => p.nsid === "com.atproto.repo.putRecord");
  return (put?.options.input.record as Record<string, unknown>) ?? null;
}

const location = (res: Response) => res.headers.get("location");

beforeEach(() => {
  posted.length = 0;
  resolveInput.mockReset();
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
  atproto.listRecords.mockResolvedValue([publication()]);
});

describe("POST /api/publish — intent=recommendations", () => {
  it("adds a resolved entry after the kept ones, leaving the rest of the record", async () => {
    resolveInput.mockResolvedValue({ ok: true, uri: FRIEND });
    const res = await save([SITES[0]], "@friend.bsky.social");
    expect(location(res)).toBe("/settings?saved=1");
    expect(posted[0]?.options.input.collection).toBe(
      "site.standard.publication",
    );
    expect(written()?.goldroadRecommendations).toEqual([
      { uri: SITES[0] },
      { uri: FRIEND },
    ]);
    expect(written()?.basicTheme).toEqual({
      $type: "site.standard.theme.basic",
    });
  });

  it("rebuilds the list from what was kept: removed entries and junk are gone", async () => {
    atproto.listRecords.mockResolvedValue([
      publication({
        goldroadRecommendations: [{ uri: SITES[0] }, { uri: SITES[1] }],
      }),
    ]);
    await save([SITES[1], "javascript:alert(1)", "http://plain.example"]);
    expect(written()?.goldroadRecommendations).toEqual([{ uri: SITES[1] }]);
  });

  it("removes the field when every entry is removed", async () => {
    atproto.listRecords.mockResolvedValue([
      publication({ goldroadRecommendations: [{ uri: SITES[0] }] }),
    ]);
    await save([]);
    expect(written()).not.toBeNull();
    expect(written()?.goldroadRecommendations).toBeUndefined();
  });

  it("refuses a seventh, and writes nothing", async () => {
    resolveInput.mockResolvedValue({ ok: true, uri: FRIEND });
    const res = await save(SITES, "@friend.bsky.social");
    expect(location(res)).toBe("/settings?error=recommend_full");
    expect(written()).toBeNull();
  });

  it("adds an entry already on the list only once", async () => {
    resolveInput.mockResolvedValue({ ok: true, uri: SITES[0] });
    await save([SITES[0]], "site0.example");
    expect(written()?.goldroadRecommendations).toEqual([{ uri: SITES[0] }]);
  });

  it("says why an address couldn't be added, and writes nothing", async () => {
    resolveInput.mockResolvedValue({ ok: false, problem: "no_publication" });
    const res = await save([], "@friend.bsky.social");
    expect(location(res)).toBe("/settings?error=recommend_no_publication");
    expect(written()).toBeNull();
  });

  it("creates no publication to hold a list", async () => {
    atproto.listRecords.mockResolvedValue([]);
    const res = await save([SITES[0]]);
    expect(location(res)).toBe("/settings?error=recommend_no_publication_yet");
    expect(posted).toHaveLength(0);
  });
});
