// @vitest-environment node
/**
 * The search backfill end to end: the route reads only the session's own repo
 * and saves its place, and the dashboard's loop calls it until it's done.
 */
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as atproto from "~/lib/atproto";
import { env } from "cloudflare:workers";

const ME = "did:plc:fake2222222222writer2222";

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveDidToPds: vi.fn(async () => "https://pds.example"),
  listRecordsPage: vi.fn(),
}));
const session = vi.hoisted(() => ({ did: "" as string | null }));
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(session.did),
}));

import { isSearchReady } from "../lib/search";
import { MAX_BACKFILL_CALLS, runSearchBackfill } from "../lib/search-backfill";
import { Route } from "../routes/api.search.backfill";
import { handlerOf } from "./support/route-handler";
import { sqliteD1 } from "./support/sqlite-d1";

const POST = handlerOf(Route, "POST");
const call = (headers: HeadersInit = {}) =>
  POST({
    request: new Request("https://trygoldroad.com/api/search/backfill", {
      method: "POST",
      headers,
    }),
  });

const doc = (rkey: string) => ({
  uri: `at://${ME}/site.standard.document/${rkey}`,
  cid: "bafyrei",
  value: { title: `Post ${rkey}`, textContent: "words" },
});

let originalDb: unknown;
beforeEach(() => {
  originalDb = env.DB;
  env.DB = sqliteD1();
  session.did = ME;
  vi.mocked(atproto.listRecordsPage).mockReset();
  return () => {
    env.DB = originalDb as D1Database;
  };
});

describe("/api/search/backfill", () => {
  it("indexes the session's repo a page at a time and resumes from its cursor", async () => {
    vi.mocked(atproto.listRecordsPage)
      .mockResolvedValueOnce({ records: [doc("3ma")], cursor: "c1" })
      .mockResolvedValueOnce({ records: [doc("3mb")], cursor: null });

    expect(await (await call()).json()).toEqual({
      ok: true,
      done: false,
      indexed: 1,
    });
    expect(await (await call()).json()).toEqual({
      ok: true,
      done: true,
      indexed: 1,
    });

    const calls = vi.mocked(atproto.listRecordsPage).mock.calls;
    expect(calls.map((c) => c[1])).toEqual([ME, ME]);
    expect(calls.map((c) => c[3]?.cursor)).toEqual([undefined, "c1"]);
    expect(await isSearchReady(drizzle(env.DB as D1Database), ME)).toBe(true);
  });

  it("treats a repo its server won't list as nothing to index", async () => {
    vi.mocked(atproto.listRecordsPage).mockRejectedValue(
      new atproto.NotFoundError("400"),
    );
    expect(await (await call()).json()).toMatchObject({ ok: true, done: true });
  });

  it("says so, and saves nothing, when the server can't be read", async () => {
    vi.mocked(atproto.listRecordsPage).mockRejectedValue(
      new atproto.ListUnavailableError("503"),
    );
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call();
    quiet.mockRestore();
    expect(res.status).toBe(502);
    expect(await isSearchReady(drizzle(env.DB as D1Database), ME)).toBe(false);
  });

  it("refuses without a session, and cross-site", async () => {
    session.did = null;
    expect((await call()).status).toBe(401);
    session.did = ME;
    expect((await call({ origin: "https://evil.example" })).status).toBe(403);
    expect(atproto.listRecordsPage).not.toHaveBeenCalled();
  });
});

describe("runSearchBackfill — the dashboard's loop", () => {
  const answering = (...bodies: unknown[]) => {
    const fetchImpl = vi.fn(async () => {
      const body = bodies.shift();
      return new Response(JSON.stringify(body), {
        status: (body as { ok?: boolean })?.ok ? 200 : 502,
      });
    });
    return fetchImpl as unknown as typeof fetch & typeof fetchImpl;
  };

  it("calls until the server says it's done", async () => {
    const fetchImpl = answering(
      { ok: true, done: false },
      { ok: true, done: false },
      { ok: true, done: true },
    );
    expect(await runSearchBackfill(fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops at the first failure, to resume next visit", async () => {
    const fetchImpl = answering({ ok: true, done: false }, { ok: false });
    expect(await runSearchBackfill(fetchImpl)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never calls more than its cap", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, done: false })),
    ) as unknown as typeof fetch;
    expect(await runSearchBackfill(fetchImpl, 5)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(MAX_BACKFILL_CALLS).toBeGreaterThan(0);
  });
});
