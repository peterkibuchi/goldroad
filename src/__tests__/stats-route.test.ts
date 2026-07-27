// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/stats route behavior: session auth, the env gate, server-side filter
 * derivation (the client can NEVER steer the query), per-DID cache isolation,
 * and upstream-error mapping. Handle resolution is mocked (it needs live DID
 * documents); session verification, filter building, and caching are the real
 * code paths.
 */
const resolveDidToHandle = vi.fn();
vi.mock("~/lib/atproto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/atproto")>();
  return {
    ...actual,
    resolveDidToHandle: (did: string) => resolveDidToHandle(did),
  };
});

import { signSession } from "~/lib/session";
import { Route } from "../routes/api.stats";
import { env } from "./mocks/cloudflare-workers";

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const GET = (
  Route.options as unknown as {
    server: { handlers: { GET: Handler } };
  }
).server.handlers.GET;

const DID_A = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const DID_B = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

async function requestAs(did: string | null, path = "/api/stats") {
  const headers: Record<string, string> = {};
  if (did) {
    const token = await signSession(did, env.COOKIE_SECRET);
    headers.cookie = `gr_session=${token}`;
  }
  return GET({
    request: new Request(`https://trygoldroad.com${path}`, { headers }),
  });
}

/** PostHog Query API stub; records every HogQL query it was sent. */
function stubUpstream(rows: Array<[string, number]> = [["/@w", 1]]) {
  const queries: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as {
      query: { query: string };
    };
    queries.push(sent.query.query);
    return new Response(JSON.stringify({ results: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, queries };
}

/** Minimal Workers-cache stand-in over a Map (mirrors read-cache.test.ts). */
function mockCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (url: URL | string) => store.get(String(url))?.clone()),
    put: vi.fn(async (url: URL | string, res: Response) => {
      store.set(String(url), res);
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { cache, store };
}

beforeEach(() => {
  resolveDidToHandle.mockReset();
  resolveDidToHandle.mockImplementation(async (did: string) =>
    did === DID_A ? "writer-a.example" : "writer-b.example",
  );
});

afterEach(() => {
  delete env.POSTHOG_QUERY_API_KEY;
  delete env.POSTHOG_PROJECT_ID;
  vi.unstubAllGlobals();
});

function enableProvider() {
  env.POSTHOG_QUERY_API_KEY = "phx_test";
  env.POSTHOG_PROJECT_ID = "12345";
}

describe("/api/stats — auth", () => {
  it("401s without a session, before touching env gates or upstream", async () => {
    const { fetcher } = stubUpstream();
    enableProvider();
    const res = await requestAs(null);
    expect(res.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("401s a forged cookie", async () => {
    const res = await GET({
      request: new Request("https://trygoldroad.com/api/stats", {
        headers: { cookie: "gr_session=forged.token" },
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("/api/stats — env gate", () => {
  it("answers the feature-off shape when the provider is unconfigured", async () => {
    const { fetcher } = stubUpstream();
    const res = await requestAs(DID_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("/api/stats — server-side filter derivation", () => {
  it("scopes the query to the SESSION writer's paths only", async () => {
    enableProvider();
    const { queries } = stubUpstream();
    await requestAs(DID_A);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("'/@writer-a.example'");
    expect(queries[0]).toContain(`'/@${DID_A}'`);
    expect(queries[0]).not.toContain("writer-b");
    expect(queries[0]).not.toContain(DID_B);
  });

  it("ignores client-supplied query params — writer A can't request B's filter", async () => {
    enableProvider();
    const { queries } = stubUpstream();
    await requestAs(
      DID_A,
      `/api/stats?did=${DID_B}&handle=writer-b.example&path=/@writer-b.example`,
    );
    expect(queries[0]).toContain("'/@writer-a.example'");
    expect(queries[0]).not.toContain("writer-b");
  });

  it("falls back to the DID-only filter when handle resolution fails", async () => {
    enableProvider();
    resolveDidToHandle.mockRejectedValue(new Error("no handle"));
    const { queries } = stubUpstream();
    const res = await requestAs(DID_A);
    expect(res.status).toBe(200);
    expect(queries[0]).toContain(`'/@${DID_A}'`);
    expect(queries[0]).not.toContain("writer-a.example");
  });
});

describe("/api/stats — response shape and upstream mapping", () => {
  it("maps upstream rows to { enabled, total, paths }", async () => {
    enableProvider();
    stubUpstream([
      ["/@writer-a.example/aaa", 30],
      ["/@writer-a.example", 12],
    ]);
    const res = await requestAs(DID_A);
    expect(await res.json()).toEqual({
      enabled: true,
      total: 42,
      paths: [
        { path: "/@writer-a.example/aaa", views: 30 },
        { path: "/@writer-a.example", views: 12 },
      ],
    });
  });

  it("maps upstream failure to { enabled, error: 'unavailable' } with no detail", async () => {
    enableProvider();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ detail: "secret upstream reason" }), {
              status: 500,
            }),
        ),
      );
      const res = await requestAs(DID_A);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ enabled: true, error: "unavailable" });
      expect(body).not.toContain("secret upstream reason");
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("/api/stats — per-DID cache isolation", () => {
  it("caches per writer: A hits A's entry, B never does", async () => {
    enableProvider();
    mockCache();
    const { fetcher } = stubUpstream();

    const missA = await requestAs(DID_A);
    expect(missA.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const hitA = await requestAs(DID_A);
    expect(hitA.headers.get("x-goldroad-cache")).toBe("HIT");
    expect(fetcher).toHaveBeenCalledTimes(1); // served from cache, no upstream

    const missB = await requestAs(DID_B);
    expect(missB.headers.get("x-goldroad-cache")).toBe("MISS");
    expect(fetcher).toHaveBeenCalledTimes(2); // B's key differs — never A's data
  });

  it("stores under a digest key (no raw DID) and serves hits as private", async () => {
    enableProvider();
    const { cache, store } = mockCache();
    stubUpstream();
    await requestAs(DID_A);
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^https:\/\/goldroad-stats\.internal\/v1\/[0-9a-f]{64}$/,
    );
    expect(keys[0]).not.toContain("did:plc");
    expect(cache.put).toHaveBeenCalledTimes(1);

    const hit = await requestAs(DID_A);
    expect(hit.headers.get("cache-control")).toBe("private, no-store");
  });

  it("never caches an unavailable answer", async () => {
    enableProvider();
    const { cache } = mockCache();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 500 })),
      );
      await requestAs(DID_A);
      expect(cache.put).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});
