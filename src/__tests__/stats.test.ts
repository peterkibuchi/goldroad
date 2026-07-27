// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  buildStatsQuery,
  escapeHogQLString,
  fetchWriterStats,
  mapQueryResults,
  statsCacheKey,
  writerPathRoots,
} from "../lib/stats";

describe("writerPathRoots — the server-derived filter", () => {
  it("covers both the handle and DID forms of the publication path", () => {
    expect(
      writerPathRoots("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "writer.example"),
    ).toEqual(["/@writer.example", "/@did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("falls back to the DID root alone when the handle didn't resolve", () => {
    expect(writerPathRoots("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", null)).toEqual([
      "/@did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });
});

describe("buildStatsQuery — scoping and injection resistance", () => {
  it("filters to pageviews, production, and ONLY the given roots", () => {
    const query = buildStatsQuery(["/@writer.example"]);
    expect(query).toContain("event = '$pageview'");
    expect(query).toContain("properties.app_env = 'production'");
    expect(query).toContain("equals(properties.$pathname, '/@writer.example')");
    expect(query).toContain(
      "startsWith(properties.$pathname, '/@writer.example/')",
    );
  });

  it("never uses LIKE — a %-bearing did:web root must not act as a wildcard", () => {
    const query = buildStatsQuery(["/@did:web:host%3A8443"]);
    expect(query).not.toMatch(/\bLIKE\b/i);
    expect(query).toContain(
      "startsWith(properties.$pathname, '/@did:web:host%3A8443/')",
    );
  });

  it("prefix-matches below a slash boundary, so /@ab never sees /@abc traffic", () => {
    const query = buildStatsQuery(["/@ab"]);
    expect(query).toContain("startsWith(properties.$pathname, '/@ab/')");
    expect(query).not.toContain("'/@ab'/"); // the equals arm is the bare root
  });

  it("escapes quotes and backslashes so a root can't break out of its literal", () => {
    expect(escapeHogQLString("a'b\\c")).toBe("a\\'b\\\\c");
    const query = buildStatsQuery(["/@evil' OR 1=1 --"]);
    // The quote is neutralized inside the string literal…
    expect(query).toContain("'/@evil\\' OR 1=1 --'");
    // …so the WHERE clause still ends exactly with our own GROUP BY tail.
    expect(query).toMatch(/GROUP BY path ORDER BY views DESC LIMIT \d+$/);
  });
});

describe("statsCacheKey — per-writer isolation", () => {
  it("separates writers: different DIDs never share a key", async () => {
    const a = await statsCacheKey("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = await statsCacheKey("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same DID (that's what makes it a cache)", async () => {
    const first = await statsCacheKey("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
    const second = await statsCacheKey("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(first).toBe(second);
  });

  it("is a synthetic internal URL that never carries the raw DID", async () => {
    const key = await statsCacheKey("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(key).toMatch(
      /^https:\/\/goldroad-stats\.internal\/v1\/[0-9a-f]{64}$/,
    );
    expect(key).not.toContain("did:plc");
  });
});

describe("mapQueryResults — stable shape from upstream rows", () => {
  it("maps rows to { total, paths } and sums the total", () => {
    const stats = mapQueryResults({
      results: [
        ["/@w/aaa", 30],
        ["/@w", 12],
      ],
    });
    expect(stats).toEqual({
      enabled: true,
      total: 42,
      paths: [
        { path: "/@w/aaa", views: 30 },
        { path: "/@w", views: 12 },
      ],
    });
  });

  it("drops malformed rows instead of failing the payload", () => {
    const stats = mapQueryResults({
      results: [["/@w", 5], "junk", ["/@w/x"], [null, 3], ["/@w/y", -1]],
    });
    expect(stats).toEqual({
      enabled: true,
      total: 5,
      paths: [{ path: "/@w", views: 5 }],
    });
  });

  it("treats a body without a results array as unavailable", () => {
    expect(mapQueryResults({ detail: "upstream error text" })).toEqual({
      enabled: true,
      error: "unavailable",
    });
    expect(mapQueryResults(null)).toEqual({
      enabled: true,
      error: "unavailable",
    });
  });
});

describe("fetchWriterStats — bounded upstream", () => {
  const okUpstream = (body: unknown) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it("POSTs a HogQL query with the bearer key to the project's query endpoint", async () => {
    const fetcher = okUpstream({ results: [["/@w", 1]] });
    const stats = await fetchWriterStats({
      apiKey: "phx_key",
      projectId: "12345",
      roots: ["/@w"],
      fetcher,
    });
    expect(stats).toEqual({
      enabled: true,
      total: 1,
      paths: [{ path: "/@w", views: 1 }],
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.posthog.com/api/projects/12345/query/");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer phx_key",
    );
    const sent = JSON.parse(String(init.body)) as {
      query: { kind: string; query: string };
    };
    expect(sent.query.kind).toBe("HogQLQuery");
    expect(sent.query.query).toContain("'/@w'");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a non-2xx answer to unavailable without leaking upstream detail", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "secret upstream reason" }), {
            status: 500,
          }),
      ) as unknown as typeof fetch;
      const stats = await fetchWriterStats({
        apiKey: "k",
        projectId: "1",
        roots: ["/@w"],
        fetcher,
      });
      expect(stats).toEqual({ enabled: true, error: "unavailable" });
      expect(JSON.stringify(stats)).not.toContain("secret upstream reason");
    } finally {
      quiet.mockRestore();
    }
  });

  it("maps network failure/timeout to unavailable", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(
      fetchWriterStats({
        apiKey: "k",
        projectId: "1",
        roots: ["/@w"],
        fetcher,
      }),
    ).resolves.toEqual({ enabled: true, error: "unavailable" });
  });

  it("caps the response body — an oversized answer reads as unavailable", async () => {
    const huge = JSON.stringify({ results: [["/".repeat(300_000), 1]] });
    const fetcher = vi.fn(
      async () =>
        new Response(huge, {
          status: 200,
          headers: { "content-length": String(huge.length) },
        }),
    ) as unknown as typeof fetch;
    await expect(
      fetchWriterStats({
        apiKey: "k",
        projectId: "1",
        roots: ["/@w"],
        fetcher,
      }),
    ).resolves.toEqual({ enabled: true, error: "unavailable" });
  });
});
