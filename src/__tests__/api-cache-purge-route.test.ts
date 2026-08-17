// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cache-purge — the takedown hook that drops taken-down reading
 * surfaces out of the edge cache.
 *
 * Why it needs its own suite: the reader pages check the hide list INSIDE their
 * loader, and a read-cache HIT skips the loader entirely, so inserting a
 * `hidden_content` row does not stop a cached page from being served. This
 * endpoint is the other half of that operation, which makes it both a
 * moderation control and an unauthenticated-by-default attack surface. What is
 * pinned here is the refusal behaviour (an unconfigured deployment exposes no
 * purge surface at all), that the two purge stages are reported SEPARATELY
 * because they succeed separately, and that a local-only purge never reads as a
 * global one.
 */

const cache = vi.hoisted(() => ({
  // Typed args, not `() => 0`: vitest infers an empty tuple otherwise and
  // reading mock.calls[0][0] stops typechecking.
  purgeLocalReadCache: vi.fn(async (_urls: readonly string[]) => 0),
}));
vi.mock("~/lib/read-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/read-cache")>()),
  ...cache,
}));

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveDidToHandle: vi.fn(async () => "writer.example"),
}));

import { Route } from "../routes/api.cache-purge";
import { env } from "./mocks/cloudflare-workers";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const TOKEN = "purge-token-for-tests";
const DID = "did:plc:ukp7pzzht32uigg6bg4vxr5t";
const RKEY = "3lyk73wxnok2f";
const AT_URI = `at://${DID}/site.standard.document/${RKEY}`;

function call(body: unknown, token?: string) {
  return POST({
    request: new Request("https://trygoldroad.com/api/cache-purge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  });
}

/** CF credentials off by default; individual tests opt in. */
function configureEnv(extra: Record<string, string> = {}) {
  delete env.TAKEDOWN_PURGE_TOKEN;
  delete env.CF_PURGE_ZONE_ID;
  delete env.CF_PURGE_API_TOKEN;
  Object.assign(env, extra);
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.purgeLocalReadCache.mockResolvedValue(0);
  configureEnv({ TAKEDOWN_PURGE_TOKEN: TOKEN });
  vi.unstubAllGlobals();
});

afterEach(() => {
  configureEnv();
  vi.unstubAllGlobals();
});

describe("authorization", () => {
  it("404s with no token configured, so a self-host exposes no purge surface", async () => {
    configureEnv();
    const res = await call({ subjects: [AT_URI] }, TOKEN);
    expect(res.status).toBe(404);
    // The important part: an unset secret must not become an empty-string
    // password that anybody can present.
    expect(cache.purgeLocalReadCache).not.toHaveBeenCalled();
  });

  it("404s on a wrong, absent, or malformed bearer token", async () => {
    for (const token of [undefined, "", "wrong-token", `${TOKEN}x`]) {
      const res = await call({ subjects: [AT_URI] }, token);
      expect(res.status, String(token)).toBe(404);
    }
    expect(cache.purgeLocalReadCache).not.toHaveBeenCalled();
  });

  it("refuses a token that only shares a prefix with the real one", async () => {
    const res = await call({ subjects: [AT_URI] }, TOKEN.slice(0, 5));
    expect(res.status).toBe(404);
  });
});

describe("subject validation", () => {
  it("rejects a body with nothing purgeable in it", async () => {
    for (const body of [
      {},
      { subjects: [] },
      { subjects: "not-an-array" },
      { subjects: ["not-a-did", "https://example.com/post"] },
    ]) {
      const res = await call(body, TOKEN);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "no_valid_subjects",
      });
    }
  });

  it("accepts exactly what the hide list stores: a DID or an at:// record URI", async () => {
    const res = await call({ subjects: [DID, AT_URI] }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, subjects: 2 });
  });
});

describe("honest reporting of the two purge stages", () => {
  it("reports the zone purge as unconfigured, and the residual window, without CF credentials", async () => {
    cache.purgeLocalReadCache.mockResolvedValue(4);
    const res = await call({ subjects: [AT_URI] }, TOKEN);
    const body = (await res.json()) as Record<string, unknown>;

    // A per-colo delete is NOT a purge, and must never be reported as one:
    // Cloudflare only evicts in the data center the Worker ran in.
    expect(body.localPurged).toBe(4);
    expect(body.zone).toEqual({ status: "unconfigured" });
    // With no global path configured, the operator is told how long an
    // un-purged copy elsewhere can still be served rather than left to infer it.
    expect(body.residualSeconds).toBe(300);
  });

  it("purges the zone by URL for a record subject, and reports zero residual", async () => {
    configureEnv({
      TAKEDOWN_PURGE_TOKEN: TOKEN,
      CF_PURGE_ZONE_ID: "zone123",
      CF_PURGE_API_TOKEN: "cf-token",
    });
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await call({ subjects: [AT_URI] }, TOKEN);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.zone).toEqual({ status: "purged", scope: "files" });
    expect(body.residualSeconds).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone123/purge_cache",
    );
    const sent = JSON.parse(String(init.body)) as { files?: string[] };
    expect(sent.files).toContain(
      `https://trygoldroad.com/@writer.example/${RKEY}`,
    );
  });

  it("purges everything for an AUTHOR subject, whose pages cannot be enumerated", async () => {
    configureEnv({
      TAKEDOWN_PURGE_TOKEN: TOKEN,
      CF_PURGE_ZONE_ID: "zone123",
      CF_PURGE_API_TOKEN: "cf-token",
    });
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await call({ subjects: [DID] }, TOKEN);
    expect(await res.json()).toMatchObject({
      zone: { status: "purged", scope: "everything" },
    });
    // A hidden author's document pages need listing their repo to enumerate,
    // and their ?cursor= archive pages cannot be enumerated at all — so for a
    // legal takedown, dropping the zone's cache is the honest answer.
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ purge_everything: true });
  });

  it("reports a failed zone purge instead of letting the local one look global", async () => {
    configureEnv({
      TAKEDOWN_PURGE_TOKEN: TOKEN,
      CF_PURGE_ZONE_ID: "zone123",
      CF_PURGE_API_TOKEN: "cf-token",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );

    const res = await call({ subjects: [AT_URI] }, TOKEN);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.zone).toEqual({ status: "failed", detail: "HTTP 403" });
    expect(body.residualSeconds).toBe(300);
  });

  it("still purges locally when the handle cannot be resolved", async () => {
    const atproto = await import("~/lib/atproto");
    vi.mocked(atproto.resolveDidToHandle).mockRejectedValue(
      new Error("directory down"),
    );
    const res = await call({ subjects: [AT_URI] }, TOKEN);
    expect(res.status).toBe(200);
    // The handle-spelled URLs are lost and age out; the purge does not fail.
    const urls = cache.purgeLocalReadCache.mock.calls[0]?.[0] ?? [];
    expect(urls.some((u) => u.includes(DID))).toBe(true);
  });
});
