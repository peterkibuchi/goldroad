// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/subscription — the one personal question the reading pages can't
 * answer themselves, because they are edge-cached without regard to cookies.
 *
 * What this pins: a signed-out reader gets an honest answer rather than an
 * error; current state is read from the READER'S own repo; a failed read is
 * never reported as "not subscribed" (opposite claims, and the wrong one shows
 * a Subscribe button to someone who already subscribed); the answer is
 * uncacheable; it never carries a record key; and it never carries a count.
 */

const atproto = vi.hoisted(() => ({
  resolveDidToPds: vi.fn(),
  listRecordPages: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

const READER = "did:plc:fake3333333333reader3333";
const session = vi.hoisted(() => ({ did: "" as string | null }));
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(session.did),
}));

import { Route } from "../routes/api.subscription";
import { handlerOf } from "./support/route-handler";

const GET = handlerOf(Route, "GET");

const WRITER = "did:plc:fake2222222222writer2222";
const PUB = `at://${WRITER}/site.standard.publication/3lyk73wxnok2f`;
const OTHER_PUB = `at://${WRITER}/site.standard.publication/otherpub0000`;

function subscriptionRow(publication: string, rkey = "3lz0000000000") {
  return {
    uri: `at://${READER}/site.standard.graph.subscription/${rkey}`,
    cid: "bafy1",
    value: { publication },
  };
}

async function ask(publication: string | null = PUB): Promise<Response> {
  const url = new URL("https://trygoldroad.com/api/subscription");
  if (publication !== null) url.searchParams.set("publication", publication);
  return GET({ request: new Request(url) });
}

beforeEach(() => {
  // Call history, not just return values: the "reads nothing upstream" cases
  // assert on not-having-been-called, and a hoisted mock outlives the test.
  vi.clearAllMocks();
  session.did = READER;
  atproto.resolveDidToPds.mockResolvedValue("https://reader-pds.example.com");
  atproto.listRecordPages.mockResolvedValue({ records: [], truncated: false });
});

describe("GET /api/subscription", () => {
  it("reports a subscription the reader holds", async () => {
    atproto.listRecordPages.mockResolvedValue({
      records: [subscriptionRow(OTHER_PUB, "aaa"), subscriptionRow(PUB)],
      truncated: false,
    });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      signedIn: true,
      subscribed: true,
    });
  });

  it("reads the READER'S own repo, in the subscription collection", async () => {
    await ask();
    expect(atproto.listRecordPages).toHaveBeenCalledWith(
      "https://reader-pds.example.com",
      READER,
      "site.standard.graph.subscription",
    );
  });

  it("reports no subscription when the reader holds none for this publication", async () => {
    atproto.listRecordPages.mockResolvedValue({
      records: [subscriptionRow(OTHER_PUB)],
      truncated: false,
    });
    expect(await (await ask()).json()).toEqual({
      ok: true,
      signedIn: true,
      subscribed: false,
    });
  });

  it("answers a signed-out reader honestly, not with an error", async () => {
    // "Are you subscribed" has an answer for an anonymous reader, and the
    // control turns it into a sign-in path rather than into a failure.
    session.did = null;
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signedIn: false });
  });

  it("reads nothing upstream for a signed-out reader", async () => {
    session.did = null;
    await ask();
    expect(atproto.listRecordPages).not.toHaveBeenCalled();
  });

  it("is uncacheable — this is one reader's relationship", async () => {
    // The page it appears on is edge-cached for 60s regardless of cookies;
    // this answer must never be stored anywhere on the way back.
    expect((await ask()).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("never hands back a record key", async () => {
    atproto.listRecordPages.mockResolvedValue({
      records: [subscriptionRow(PUB)],
      truncated: false,
    });
    const body = JSON.stringify(await (await ask()).json());
    expect(body).not.toContain("3lz0000000000");
    expect(body).not.toContain("rkey");
  });

  it("never carries a subscriber count", async () => {
    // There is no reverse lookup to count with, so there is no number to show
    // and none is invented — not even a zero.
    const body = (await (await ask()).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "signedIn", "subscribed"]);
    expect(Object.values(body).some((v) => typeof v === "number")).toBe(false);
  });

  it("refuses a publication that is not an AT-URI", async () => {
    for (const publication of [
      "https://evil.example/publication",
      "at://",
      "",
      "did:plc:fake2222222222writer2222",
    ]) {
      const res = await ask(publication);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "invalid_publication",
      });
    }
    expect(atproto.listRecordPages).not.toHaveBeenCalled();
  });

  it("refuses a missing publication param", async () => {
    expect((await ask(null)).status).toBe(400);
  });

  it("says it could not tell, rather than 'not subscribed', on a failed read", async () => {
    atproto.listRecordPages.mockRejectedValue(new Error("pds down"));
    const res = await ask();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
  });

  it("says it could not tell when the reader's PDS won't resolve", async () => {
    atproto.resolveDidToPds.mockRejectedValue(new Error("no did doc"));
    const res = await ask();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable" });
  });
});
