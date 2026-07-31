// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reader intents on /api/publish — the only write path a subscription takes.
 *
 * What this pins: the record lands in the READER'S repo and points at the
 * publication's AT-URI; the URI is untrusted input and never reaches a record
 * unvalidated; unsubscribing deletes the key WE looked up rather than one the
 * form supplied; a stale button cannot write a second record; a grant that
 * predates the subscription scope produces a sign-in-again answer instead of a
 * button that silently does nothing; and no answer on this path carries a
 * subscriber count, because there is no way to know one.
 */

const atproto = vi.hoisted(() => ({
  resolveDidToHandle: vi.fn(),
  resolveDidToPds: vi.fn(),
  listRecordPages: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

/** The XRPC calls the handler makes, in order. */
const posted = vi.hoisted(
  () =>
    [] as Array<{ nsid: string; options: { input: Record<string, unknown> } }>,
);
const postResult = vi.hoisted(() => ({
  current: { ok: true, status: 200, data: {} } as {
    ok: boolean;
    status: number;
    data: Record<string, unknown>;
  },
}));
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, options });
      return Promise.resolve(postResult.current);
    }
  },
}));

const restoreFails = vi.hoisted(() => ({ current: false }));
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: () => ({
    restore: () =>
      restoreFails.current
        ? Promise.reject(new Error("no session row"))
        : Promise.resolve({}),
  }),
}));

const READER = "did:plc:fake3333333333reader3333";
const session = vi.hoisted(() => ({ did: "" as string | null }));
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(session.did),
}));

import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const WRITER = "did:plc:fake2222222222writer2222";
const PUB = `at://${WRITER}/site.standard.publication/3lyk73wxnok2f`;
const OTHER_PUB = `at://${WRITER}/site.standard.publication/otherpub0000`;
const SUB_URI = `at://${READER}/site.standard.graph.subscription/3lz0000000000`;

async function call(
  fields: Record<string, string>,
  headers?: HeadersInit,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return POST({
    request: new Request("https://trygoldroad.com/api/publish", {
      method: "POST",
      body: form,
      headers,
    }),
  });
}

const subscribe = (publication = PUB) =>
  call({ intent: "subscribe", publication });
const unsubscribe = (publication = PUB) =>
  call({ intent: "unsubscribe", publication });

function callOf(nsid: string) {
  return posted.find((p) => p.nsid === nsid);
}

beforeEach(() => {
  posted.length = 0;
  postResult.current = { ok: true, status: 200, data: {} };
  restoreFails.current = false;
  session.did = READER;
  atproto.resolveDidToHandle.mockResolvedValue("reader.example");
  atproto.resolveDidToPds.mockResolvedValue("https://reader-pds.example.com");
  // The reader's own subscription collection, as their PDS lists it.
  atproto.listRecordPages.mockResolvedValue({ records: [], truncated: false });
});

describe("POST /api/publish — intent=subscribe", () => {
  it("writes the subscription into the READER'S repo, pointing at the publication", async () => {
    const res = await subscribe();

    const created = callOf("com.atproto.repo.createRecord");
    expect(created).toBeDefined();
    // The whole design in one assertion: the record is the reader's, about
    // somebody else's publication.
    expect(created?.options.input.repo).toBe(READER);
    expect(created?.options.input.collection).toBe(
      "site.standard.graph.subscription",
    );
    const record = created?.options.input.record as Record<string, unknown>;
    expect(record.$type).toBe("site.standard.graph.subscription");
    expect(record.publication).toBe(PUB);
    expect(typeof record.createdAt).toBe("string");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, subscribed: true });
  });

  it("lets the PDS mint the key — a subscription needs no key of ours", async () => {
    await subscribe();
    expect(callOf("com.atproto.repo.createRecord")?.options.input.rkey).toBe(
      undefined,
    );
  });

  it("answers privately — this is one reader's relationship, not a public fact", async () => {
    const res = await subscribe();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("never reports a subscriber count, because there is no way to know one", async () => {
    const body = (await (await subscribe()).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "subscribed"]);
  });

  it("refuses anything that is not an AT-URI, and writes nothing", async () => {
    // The publication URI is the untrusted input on this path: it arrives from
    // the page the reader was on.
    for (const publication of [
      "https://evil.example/publication",
      "at://",
      "javascript:alert(1)",
      "did:plc:fake2222222222writer2222",
      "",
      "at:// spaced /site.standard.publication/x",
    ]) {
      posted.length = 0;
      const res = await subscribe(publication);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "invalid_publication",
      });
      expect(posted).toHaveLength(0);
    }
  });

  it("refuses a missing publication field", async () => {
    const res = await call({ intent: "subscribe" });
    expect(res.status).toBe(400);
    expect(posted).toHaveLength(0);
  });

  it("does not write a second record when the reader already subscribes", async () => {
    atproto.listRecordPages.mockResolvedValue({
      records: [{ uri: SUB_URI, cid: "bafy1", value: { publication: PUB } }],
      truncated: false,
    });
    const res = await subscribe();
    expect(posted).toHaveLength(0);
    expect(await res.json()).toEqual({ ok: true, subscribed: true });
  });

  it("still writes when the reader subscribes to OTHER publications", async () => {
    atproto.listRecordPages.mockResolvedValue({
      records: [
        { uri: SUB_URI, cid: "bafy1", value: { publication: OTHER_PUB } },
      ],
      truncated: false,
    });
    await subscribe();
    expect(callOf("com.atproto.repo.createRecord")).toBeDefined();
  });

  it("subscribes anyway when the duplicate check flakes", async () => {
    // A reader whose PDS hiccuped on an unrelated list must not be told they
    // cannot subscribe. The cost is a possible duplicate, which is recoverable.
    atproto.listRecordPages.mockRejectedValue(new Error("pds down"));
    const res = await subscribe();
    expect(callOf("com.atproto.repo.createRecord")).toBeDefined();
    expect(res.status).toBe(201);
  });

  it("asks the reader to sign in again when their grant predates the scope", async () => {
    for (const status of [401, 403]) {
      posted.length = 0;
      postResult.current = { ok: false, status, data: {} };
      const res = await subscribe();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        ok: false,
        error: "subscription_scope",
      });
    }
  });

  it("reports a PDS rejection instead of claiming a subscription", async () => {
    postResult.current = {
      ok: false,
      status: 500,
      data: { error: "InternalServerError" },
    };
    const res = await subscribe();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "subscribe_failed" });
  });

  it("says so plainly when the reader's own PDS could not be resolved", async () => {
    atproto.resolveDidToPds.mockRejectedValue(new Error("no did doc"));
    const res = await subscribe();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
    expect(posted).toHaveLength(0);
  });
});

describe("POST /api/publish — intent=unsubscribe", () => {
  beforeEach(() => {
    atproto.listRecordPages.mockResolvedValue({
      records: [
        { uri: SUB_URI, cid: "bafy1", value: { publication: PUB } },
        {
          uri: `at://${READER}/site.standard.graph.subscription/3lzother0000`,
          cid: "bafy2",
          value: { publication: OTHER_PUB },
        },
      ],
      truncated: false,
    });
  });

  it("deletes the reader's subscription to this publication", async () => {
    const res = await unsubscribe();
    const deleted = callOf("com.atproto.repo.deleteRecord");
    expect(deleted?.options.input).toEqual({
      repo: READER,
      collection: "site.standard.graph.subscription",
      rkey: "3lz0000000000",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subscribed: false });
  });

  it("deletes the key it looked up, never one the form supplied", async () => {
    // The form carries the publication and nothing else, so a caller cannot
    // name the record that gets removed.
    await call({
      intent: "unsubscribe",
      publication: PUB,
      rkey: "3lzattacker00",
    });
    expect(callOf("com.atproto.repo.deleteRecord")?.options.input.rkey).toBe(
      "3lz0000000000",
    );
  });

  it("reports success when there is nothing to delete", async () => {
    // The state the reader asked for is the state they are in.
    atproto.listRecordPages.mockResolvedValue({
      records: [],
      truncated: false,
    });
    const res = await unsubscribe();
    expect(posted).toHaveLength(0);
    expect(await res.json()).toEqual({ ok: true, subscribed: false });
  });

  it("does NOT claim success when the lookup itself failed", async () => {
    // Saying "unsubscribed" about a record we never managed to read would be a
    // lie, and the control would then show a state the repo doesn't hold.
    atproto.listRecordPages.mockRejectedValue(new Error("pds down"));
    const res = await unsubscribe();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
    expect(posted).toHaveLength(0);
  });

  it("refuses anything that is not an AT-URI, and deletes nothing", async () => {
    const res = await unsubscribe("https://evil.example/publication");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "invalid_publication",
    });
    expect(posted).toHaveLength(0);
  });

  it("asks the reader to sign in again when their grant predates the scope", async () => {
    postResult.current = { ok: false, status: 403, data: {} };
    const res = await unsubscribe();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error: "subscription_scope",
    });
  });

  it("reports a PDS rejection instead of claiming a removal", async () => {
    postResult.current = {
      ok: false,
      status: 500,
      data: { error: "InternalServerError" },
    };
    const res = await unsubscribe();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: "unsubscribe_failed",
    });
  });
});

describe("POST /api/publish — the reader intents' shared gates", () => {
  it("refuses a cross-site post before reading the session", async () => {
    const res = await call(
      { intent: "subscribe", publication: PUB },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(posted).toHaveLength(0);
  });

  it("refuses a signed-out reader", async () => {
    session.did = null;
    for (const intent of ["subscribe", "unsubscribe"]) {
      const res = await call({ intent, publication: PUB });
      expect(res.status).toBe(401);
      expect(posted).toHaveLength(0);
    }
  });

  it("answers a dead session in JSON, not with a redirect to the editor", async () => {
    // These are called by fetch from a reading page: a 303 to /write would
    // arrive as an unreadable HTML body, and the control would show nothing.
    restoreFails.current = true;
    for (const intent of ["subscribe", "unsubscribe"]) {
      const res = await call({ intent, publication: PUB });
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ ok: false, error: "session_expired" });
    }
  });
});
