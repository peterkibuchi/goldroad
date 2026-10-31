// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Start here" pin on /api/publish's profile save (intent=publication).
 *
 * What this pins: the form names a post by rkey and the server mints the
 * AT-URI from the session's DID, so a pin can only point into the writer's own
 * repo; "" unpins; a form without the field keeps the current pin, re-checked
 * rather than carried over blind; and every other field on the record survives.
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

const PIN = `at://${DID}/site.standard.document/3lyk73wxnok2f`;

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

async function save(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  form.append("intent", "publication");
  form.append("name", "The Long Way");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
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

beforeEach(() => {
  posted.length = 0;
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
  atproto.listRecords.mockResolvedValue([publication()]);
});

describe("POST /api/publish — the Start here pin", () => {
  it("pins the writer's own post, minting the URI from their DID", async () => {
    const res = await save({ pinnedPost: "3lyk73wxnok2f" });
    expect(res.headers.get("location")).toBe("/settings?saved=1");
    expect(written()?.goldroadPinnedPost).toBe(PIN);
    // The rest of the record is untouched.
    expect(written()?.basicTheme).toEqual({
      $type: "site.standard.theme.basic",
    });
  });

  it("can't be pointed at another repo, whatever the form says", async () => {
    const res = await save({
      pinnedPost:
        "at://did:plc:someoneelse22222222222222/site.standard.document/3lyk73wxnok2f",
    });
    expect(res.headers.get("location")).toBe("/settings?error=pin_invalid");
    expect(written()).toBeNull();
  });

  it("refuses a bad pin before uploading anything", async () => {
    const form = new FormData();
    form.append("intent", "publication");
    form.append("name", "The Long Way");
    form.append("pinnedPost", "not/an/rkey");
    form.append(
      "icon",
      new File([new Uint8Array(10)], "i.png", { type: "image/png" }),
    );
    const res = await POST({
      request: new Request("https://trygoldroad.com/api/publish", {
        method: "POST",
        body: form,
      }),
    });
    expect(res.headers.get("location")).toBe("/settings?error=pin_invalid");
    expect(posted).toHaveLength(0);
  });

  it('unpins on ""', async () => {
    atproto.listRecords.mockResolvedValue([
      publication({ goldroadPinnedPost: PIN }),
    ]);
    await save({ pinnedPost: "" });
    expect(written()).not.toBeNull();
    expect(written()?.goldroadPinnedPost).toBeUndefined();
  });

  it("keeps the current pin when the form carries no pin field", async () => {
    atproto.listRecords.mockResolvedValue([
      publication({ goldroadPinnedPost: PIN }),
    ]);
    await save({});
    expect(written()?.goldroadPinnedPost).toBe(PIN);
  });

  it("drops a kept pin that points elsewhere instead of carrying it over", async () => {
    atproto.listRecords.mockResolvedValue([
      publication({
        goldroadPinnedPost:
          "at://did:plc:someoneelse22222222222222/site.standard.document/3lyk73wxnok2f",
      }),
    ]);
    await save({});
    expect(written()).not.toBeNull();
    expect(written()?.goldroadPinnedPost).toBeUndefined();
  });
});
