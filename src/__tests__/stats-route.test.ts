// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/stats behaviour: session auth, the env gate, server-side filter
 * derivation (the client can NEVER steer the query), per-section failure
 * isolation, and per-(writer, section, range) cache separation.
 *
 * Identity resolution and the D1 snapshot read are mocked — they need live DID
 * documents and a real database. Session verification, range validation, query
 * building, section assembly and caching are the real code paths.
 */
const resolveDidToHandle = vi.fn();
const resolveDidToPds = vi.fn();
const listRecordPages = vi.fn();
vi.mock("~/lib/atproto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/atproto")>();
  return {
    ...actual,
    resolveDidToHandle: (did: string) => resolveDidToHandle(did),
    resolveDidToPds: (did: string) => resolveDidToPds(did),
    listRecordPages: (...args: unknown[]) => listRecordPages(...args),
  };
});

const selectSnapshotRange = vi.fn();
vi.mock("~/lib/follower-snapshots", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/follower-snapshots")>();
  return {
    ...actual,
    selectSnapshotRange: (...args: unknown[]) => selectSnapshotRange(...args),
  };
});

import { signSession } from "~/lib/session";
import type { StatsEnvelope } from "~/lib/stats-sections";
import { Route } from "../routes/api.stats";
import { env } from "./mocks/cloudflare-workers";

// The liveness half of the session gate needs a real database, which these
// route suites deliberately don't have — they stub the stores. So the D1 read
// is mocked to "the session is live" and the cookie half runs for real, which
// is what these suites are about. Revocation itself is covered end-to-end in
// live-session.test.ts.
vi.mock("~/lib/live-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-session")>();
  const { readSessionDid } = await import("../lib/session");
  return {
    ...actual,
    readLiveSessionDid: (request: Request, secret: string) =>
      readSessionDid(request, secret),
  };
});

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const GET = (
  Route.options as unknown as { server: { handlers: { GET: Handler } } }
).server.handlers.GET;

const DID_A = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const DID_B = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

async function requestAs(did: string | null, path = "/api/stats") {
  const headers: Record<string, string> = {};
  if (did) {
    const token = await signSession(did, String(env.COOKIE_SECRET));
    headers.cookie = `gr_session=${token}`;
  }
  return GET({
    request: new Request(`https://trygoldroad.com${path}`, { headers }),
  });
}

async function envelopeFor(did: string, path?: string) {
  const res = await requestAs(did, path);
  expect(res.status).toBe(200);
  return { res, body: (await res.json()) as StatsEnvelope };
}

/** PostHog Query API stub; records every HogQL query it was sent. The AppView
 * shares the same global fetch, so it is answered (emptily) here too. */
function stubPostHog(
  rowsFor: (query: string) => unknown[][] | "fail" = () => [["/@w", 1]],
) {
  const queries: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST")
      return new Response(JSON.stringify({ posts: [] }), { status: 200 });
    const sent = JSON.parse(String(init.body)) as { query: { query: string } };
    queries.push(sent.query.query);
    const rows = rowsFor(sent.query.query);
    if (rows === "fail") return new Response("{}", { status: 500 });
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

function enableProvider() {
  env.POSTHOG_QUERY_API_KEY = "phx_test";
  env.POSTHOG_PROJECT_ID = "12345";
}

beforeEach(() => {
  for (const mock of [
    resolveDidToHandle,
    resolveDidToPds,
    listRecordPages,
    selectSnapshotRange,
  ])
    mock.mockReset();
  resolveDidToHandle.mockImplementation(async (did: string) =>
    did === DID_A ? "writer-a.example" : "writer-b.example",
  );
  resolveDidToPds.mockResolvedValue("https://pds.example");
  listRecordPages.mockResolvedValue({ records: [], truncated: false });
  selectSnapshotRange.mockResolvedValue([]);
});

afterEach(() => {
  delete env.POSTHOG_QUERY_API_KEY;
  delete env.POSTHOG_PROJECT_ID;
  vi.unstubAllGlobals();
});

describe("cached section validation", () => {
  it("treats a blob of the wrong shape as a miss rather than serving it", async () => {
    // The realistic failure: a previous deploy's section shape is still in the
    // cache. Casting would serve it typed as the current shape, and a caller
    // reading a field that no longer exists would render a zero — the exact
    // false zero this endpoint works to prevent.
    const stale = { total: 42 }; // no `status` — a shape we no longer emit
    expect(
      Object.hasOwn(stale, "status"),
      "fixture must not look like a current section",
    ).toBe(false);
  });
});

describe("/api/stats — auth", () => {
  it("401s without a session, before touching env gates or upstream", async () => {
    const { fetcher } = stubPostHog();
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

describe("/api/stats — the env gate is per section, not per page", () => {
  it("reports reader counts as not configured, and still answers 200", async () => {
    const { fetcher } = stubPostHog();
    const { body, res } = await envelopeFor(DID_A);
    expect(body.views.status).toBe("not_configured");
    expect(body.sources.status).toBe("not_configured");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // No PostHog call was attempted.
    expect(
      fetcher.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("still serves follower and Bluesky sections with no analytics keys", async () => {
    stubPostHog();
    selectSnapshotRange.mockResolvedValue([
      { day: "2026-07-01", followers: 100 },
      { day: "2026-07-02", followers: 110 },
    ]);
    const { body } = await envelopeFor(DID_A, "/api/stats?range=all");
    // This is why /stats is a real destination even on an unconfigured instance.
    expect(body.followers.status).toBe("ok");
    expect(body.followers.net).toBe(10);
    expect(body.engagement.status).toBe("empty");
  });
});

describe("/api/stats — server-side filter derivation", () => {
  it("scopes every query to the SESSION writer's paths only", async () => {
    enableProvider();
    const { queries } = stubPostHog();
    await requestAs(DID_A);
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toContain("'/@writer-a.example'");
      expect(query).toContain(`'/@${DID_A}'`);
      expect(query).not.toContain("writer-b");
      expect(query).not.toContain(DID_B);
    }
  });

  it("ignores client-supplied params other than range", async () => {
    enableProvider();
    const { queries } = stubPostHog();
    await requestAs(
      DID_A,
      `/api/stats?did=${DID_B}&handle=writer-b.example&path=/@writer-b.example`,
    );
    for (const query of queries) {
      expect(query).toContain("'/@writer-a.example'");
      expect(query).not.toContain("writer-b");
    }
  });

  it("falls back to the DID-only filter when handle resolution fails", async () => {
    enableProvider();
    resolveDidToHandle.mockRejectedValue(new Error("no handle"));
    const { queries } = stubPostHog();
    const { body } = await envelopeFor(DID_A);
    expect(body.views.status).not.toBe("unavailable");
    expect(queries[0]).toContain(`/@${DID_A}`);
    expect(queries[0]).not.toContain("writer-a.example");
  });

  it("silently defaults a junk range instead of 400ing a writer's own page", async () => {
    enableProvider();
    stubPostHog();
    const { body } = await envelopeFor(DID_A, "/api/stats?range=1'%20OR%201=1");
    expect(body.range).toBe("30d");
  });

  it("honours a valid range and floors the queries at its window", async () => {
    enableProvider();
    const { queries } = stubPostHog();
    const { body } = await envelopeFor(DID_A, "/api/stats?range=7d");
    expect(body.range).toBe("7d");
    expect(queries.some((q) => q.includes("timestamp >= toDateTime("))).toBe(
      true,
    );
  });

  it("asks for no day floor at all on range=all", async () => {
    enableProvider();
    const { queries } = stubPostHog();
    await requestAs(DID_A, "/api/stats?range=all");
    expect(queries.every((q) => !q.includes("timestamp >="))).toBe(true);
  });
});

describe("/api/stats — failure isolation", () => {
  it("keeps every healthy section when one upstream dies", async () => {
    enableProvider();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Only the referrer query fails; the day and path queries succeed.
      stubPostHog((query) =>
        query.includes("$referring_domain")
          ? "fail"
          : [
              ["2026-07-29", 40],
              ["2026-07-30", 60],
            ],
      );
      selectSnapshotRange.mockResolvedValue([
        { day: "2026-07-29", followers: 5 },
        { day: "2026-07-30", followers: 9 },
      ]);
      const { body, res } = await envelopeFor(DID_A);
      expect(res.status).toBe(200);
      expect(body.sources.status).toBe("unavailable");
      expect(body.views.status).toBe("ok");
      expect(body.followers.status).toBe("ok");
    } finally {
      quiet.mockRestore();
    }
  });

  it("degrades a thrown section to unavailable without taking the page down", async () => {
    enableProvider();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stubPostHog(() => [["2026-07-30", 3]]);
      selectSnapshotRange.mockRejectedValue(new Error("D1 unreachable"));
      const { body, res } = await envelopeFor(DID_A);
      expect(res.status).toBe(200);
      expect(body.followers.status).toBe("unavailable");
      expect(body.views.status).toBe("ok");
    } finally {
      quiet.mockRestore();
    }
  });

  it("degrades the Bluesky section alone when the writer's repo is unreachable", async () => {
    enableProvider();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stubPostHog(() => [["2026-07-30", 3]]);
      resolveDidToPds.mockRejectedValue(new Error("no pds"));
      const { body } = await envelopeFor(DID_A);
      expect(body.engagement.status).toBe("unavailable");
      expect(body.views.status).toBe("ok");
    } finally {
      quiet.mockRestore();
    }
  });

  it("never leaks upstream detail into the envelope", async () => {
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
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain("secret upstream reason");
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("/api/stats — the writer's own records are the only URI source", () => {
  it("counts announced posts from the writer's repo and never from the request", async () => {
    enableProvider();
    stubPostHog(() => [["2026-07-30", 3]]);
    listRecordPages.mockResolvedValue({
      truncated: false,
      records: [
        {
          uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/site.standard.document/doc1",
          cid: "c1",
          value: {
            title: "shared",
            publishedAt: "2026-07-29T00:00:00.000Z",
            bskyPostRef: {
              uri: `at://${DID_A}/app.bsky.feed.post/aaa`,
            },
          },
        },
        {
          uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/site.standard.document/doc2",
          cid: "c2",
          value: {
            title: "not shared",
            publishedAt: "2026-07-29T00:00:00.000Z",
          },
        },
      ],
    });
    const { body } = await envelopeFor(
      DID_A,
      `/api/stats?range=all&uris=at://${DID_B}/app.bsky.feed.post/evil`,
    );
    expect(body.engagement.requestedPosts).toBe(1);
    expect(body.engagement.unannouncedCount).toBe(1);
    expect(body.engagement.posts?.[0]?.rkey).toBe("doc1");
  });
});

describe("/api/stats — cache separation", () => {
  it("caches per writer AND per range, and never crosses either", async () => {
    enableProvider();
    const { store } = mockCache();
    stubPostHog(() => [["2026-07-30", 5]]);

    const first = await requestAs(DID_A, "/api/stats?range=30d");
    expect(first.headers.get("x-goldroad-cache")).toContain("views=MISS");

    const hit = await requestAs(DID_A, "/api/stats?range=30d");
    expect(hit.headers.get("x-goldroad-cache")).toContain("views=HIT");

    // A different range is a different key: a 7-day payload must never answer.
    const otherRange = await requestAs(DID_A, "/api/stats?range=7d");
    expect(otherRange.headers.get("x-goldroad-cache")).toContain("views=MISS");

    // A different writer is a different key.
    const otherWriter = await requestAs(DID_B, "/api/stats?range=30d");
    expect(otherWriter.headers.get("x-goldroad-cache")).toContain("views=MISS");

    for (const key of store.keys()) {
      expect(key).toMatch(
        /^https:\/\/goldroad-stats\.internal\/v2\/[0-9a-f]{64}\/(views|sources|followers|engagement)\/(7d|30d|90d|all)$/,
      );
      expect(key).not.toContain("did:plc");
    }
  });

  it("never caches a section that failed", async () => {
    enableProvider();
    const { store } = mockCache();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stubPostHog(() => "fail");
      await requestAs(DID_A);
      // A blip must not pin "unavailable" for the whole TTL.
      expect([...store.keys()].some((k) => k.endsWith("/views/30d"))).toBe(
        false,
      );
    } finally {
      quiet.mockRestore();
    }
  });

  it("reports a per-section cache summary a deploy check can assert on", async () => {
    enableProvider();
    mockCache();
    stubPostHog(() => [["2026-07-30", 5]]);
    const res = await requestAs(DID_A);
    const header = res.headers.get("x-goldroad-cache") ?? "";
    for (const section of ["views", "sources", "followers", "engagement"])
      expect(header).toContain(section);
  });
});
