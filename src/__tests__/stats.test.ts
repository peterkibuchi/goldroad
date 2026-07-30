// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  buildDailyViewsQuery,
  buildReferrerQuery,
  buildStatsQuery,
  DEFAULT_RANGE,
  escapeHogQLString,
  mapDayRows,
  mapDomainRows,
  mapPathRows,
  parseStatsRange,
  rangeDays,
  runHogQL,
  SECTION_TTL_SECONDS,
  statsCacheKey,
  writerPathRoots,
} from "../lib/stats";

const DID_A = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const DID_B = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

describe("writerPathRoots — the server-derived filter", () => {
  it("covers both the handle and DID forms of the publication path", () => {
    expect(writerPathRoots(DID_A, "writer.example")).toEqual([
      "/@writer.example",
      `/@${DID_A}`,
    ]);
  });

  it("falls back to the DID root alone when the handle didn't resolve", () => {
    expect(writerPathRoots(DID_A, null)).toEqual([`/@${DID_A}`]);
  });
});

describe("parseStatsRange — the only client input that reaches a query", () => {
  it("accepts exactly the four known windows", () => {
    for (const range of ["7d", "30d", "90d", "all"] as const) {
      expect(parseStatsRange(range)).toBe(range);
    }
  });

  it("falls back to the default for anything else, and never throws", () => {
    for (const junk of [
      undefined,
      null,
      "",
      "8d",
      "30D",
      "1' OR 1=1",
      "999999d",
      42,
      {},
      [],
    ]) {
      expect(parseStatsRange(junk)).toBe(DEFAULT_RANGE);
    }
  });

  it("maps each range through the frozen day record, never arithmetic on input", () => {
    expect(rangeDays("7d")).toBe(7);
    expect(rangeDays("30d")).toBe(30);
    expect(rangeDays("90d")).toBe(90);
    // "All time" has no day count — nothing to floor the query at.
    expect(rangeDays("all")).toBeNull();
  });
});

describe("query builders — scoping and injection resistance", () => {
  it("filters to pageviews, production, and ONLY the given roots", () => {
    for (const query of [
      buildStatsQuery(["/@writer.example"]),
      buildDailyViewsQuery(["/@writer.example"]),
      buildReferrerQuery(["/@writer.example"]),
    ]) {
      expect(query).toContain("event = '$pageview'");
      expect(query).toContain("properties.app_env = 'production'");
      expect(query).toContain(
        "equals(properties.$pathname, '/@writer.example')",
      );
      expect(query).toContain(
        "startsWith(properties.$pathname, '/@writer.example/')",
      );
    }
  });

  it("never uses LIKE — a %-bearing did:web root must not act as a wildcard", () => {
    for (const query of [
      buildStatsQuery(["/@did:web:host%3A8443"]),
      buildDailyViewsQuery(["/@did:web:host%3A8443"], "2026-07-01"),
      buildReferrerQuery(["/@did:web:host%3A8443"], "2026-07-01"),
    ]) {
      expect(query).not.toMatch(/\bLIKE\b/i);
      expect(query).toContain(
        "startsWith(properties.$pathname, '/@did:web:host%3A8443/')",
      );
    }
  });

  it("prefix-matches below a slash boundary, so /@ab never sees /@abc traffic", () => {
    const query = buildStatsQuery(["/@ab"]);
    expect(query).toContain("startsWith(properties.$pathname, '/@ab/')");
    expect(query).not.toContain("'/@ab'/"); // the equals arm is the bare root
  });

  it("escapes quotes and backslashes so a root can't break out of its literal", () => {
    expect(escapeHogQLString("a'b\\c")).toBe("a\\'b\\\\c");
    const query = buildStatsQuery(["/@evil' OR 1=1 --"]);
    expect(query).toContain("'/@evil\\' OR 1=1 --'");
    // …so the WHERE clause still ends exactly with our own tail.
    expect(query).toMatch(/GROUP BY path ORDER BY views DESC LIMIT \d+$/);
  });

  it("carries a bounded LIMIT on every query", () => {
    expect(buildStatsQuery(["/@w"])).toMatch(/LIMIT 200$/);
    expect(buildDailyViewsQuery(["/@w"])).toMatch(/LIMIT 800$/);
    expect(buildReferrerQuery(["/@w"])).toMatch(/LIMIT 100$/);
  });

  it("adds a UTC day floor only when a window was asked for", () => {
    expect(buildDailyViewsQuery(["/@w"])).not.toContain("timestamp >=");
    expect(buildDailyViewsQuery(["/@w"], "2026-07-01")).toContain(
      "timestamp >= toDateTime('2026-07-01 00:00:00', 'UTC')",
    );
  });

  it("buckets days in UTC, so the two series agree about what a day is", () => {
    expect(buildDailyViewsQuery(["/@w"])).toContain("toDate(timestamp, 'UTC')");
  });

  it("refuses a day floor that isn't a day — validated at the interpolation point", () => {
    expect(() =>
      buildDailyViewsQuery(["/@w"], "2026-07-01' OR 1=1 --"),
    ).toThrow();
    expect(() => buildReferrerQuery(["/@w"], "yesterday")).toThrow();
  });

  it("groups referrers by the referring domain, most traffic first", () => {
    const query = buildReferrerQuery(["/@w"]);
    expect(query).toContain("properties.$referring_domain AS domain");
    expect(query).toContain("ORDER BY views DESC");
  });
});

describe("statsCacheKey — per-writer, per-section, per-range isolation", () => {
  it("separates writers: different DIDs never share a key", async () => {
    expect(await statsCacheKey(DID_A, "views", "30d")).not.toBe(
      await statsCacheKey(DID_B, "views", "30d"),
    );
  });

  it("separates ranges: a 7-day payload can never answer a 30-day request", async () => {
    expect(await statsCacheKey(DID_A, "views", "7d")).not.toBe(
      await statsCacheKey(DID_A, "views", "30d"),
    );
  });

  it("separates sections: a dead upstream can't evict a healthy neighbour", async () => {
    expect(await statsCacheKey(DID_A, "views", "30d")).not.toBe(
      await statsCacheKey(DID_A, "engagement", "30d"),
    );
  });

  it("is deterministic for the same triple (that's what makes it a cache)", async () => {
    expect(await statsCacheKey(DID_A, "sources", "90d")).toBe(
      await statsCacheKey(DID_A, "sources", "90d"),
    );
  });

  it("is a synthetic internal URL that never carries the raw DID", async () => {
    const key = await statsCacheKey(DID_A, "followers", "all");
    expect(key).toMatch(
      /^https:\/\/goldroad-stats\.internal\/v2\/[0-9a-f]{64}\/followers\/all$/,
    );
    expect(key).not.toContain("did:plc");
  });

  it("gives followers the longest life — the data changes once a day", () => {
    expect(SECTION_TTL_SECONDS.followers).toBeGreaterThan(
      SECTION_TTL_SECONDS.engagement,
    );
    expect(SECTION_TTL_SECONDS.engagement).toBeGreaterThan(
      SECTION_TTL_SECONDS.views,
    );
  });
});

describe("mapPathRows / mapDayRows / mapDomainRows", () => {
  it("maps per-path rows and drops malformed ones", () => {
    expect(
      mapPathRows({
        results: [["/@w", 5], "junk", ["/@w/x"], [null, 3], ["/@w/y", -1]],
      }),
    ).toEqual([{ path: "/@w", views: 5 }]);
  });

  it("maps day rows oldest-first, tolerating a datetime rendering", () => {
    expect(
      mapDayRows({
        results: [
          ["2026-07-03", 5],
          ["2026-07-01 00:00:00", 2],
          ["not a day", 9],
          ["2026-07-02", "twelve"],
        ],
      }),
    ).toEqual([
      { day: "2026-07-01", views: 2 },
      { day: "2026-07-03", views: 5 },
    ]);
  });

  it("keeps an absent referring domain as null — that's a real bucket, not a bad row", () => {
    expect(
      mapDomainRows({
        results: [
          ["bsky.app", 10],
          [null, 4],
          ["", 1],
          ["nope", "x"],
        ],
      }),
    ).toEqual([
      { domain: "bsky.app", views: 10 },
      { domain: null, views: 4 },
      { domain: "", views: 1 },
    ]);
  });

  it("returns null when the body isn't a result set at all", () => {
    for (const mapper of [mapPathRows, mapDayRows, mapDomainRows]) {
      expect(mapper({ detail: "upstream error text" })).toBeNull();
      expect(mapper(null)).toBeNull();
    }
  });
});

describe("runHogQL — bounded upstream", () => {
  it("POSTs a HogQL query with the bearer key to the project's query endpoint", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [["/@w", 1]] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const body = await runHogQL({
      apiKey: "phx_key",
      projectId: "12345",
      query: buildStatsQuery(["/@w"]),
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(mapPathRows(body)).toEqual([{ path: "/@w", views: 1 }]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
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

  it("maps a non-2xx answer to null without leaking upstream detail", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = await runHogQL({
        apiKey: "k",
        projectId: "1",
        query: "SELECT 1",
        fetcher: (async () =>
          new Response(JSON.stringify({ detail: "secret upstream reason" }), {
            status: 500,
          })) as unknown as typeof fetch,
      });
      expect(body).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });

  it("maps network failure/timeout to null", async () => {
    await expect(
      runHogQL({
        apiKey: "k",
        projectId: "1",
        query: "SELECT 1",
        fetcher: (async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });

  it("caps the response body — an oversized answer reads as null", async () => {
    const huge = JSON.stringify({ results: [["/".repeat(300_000), 1]] });
    await expect(
      runHogQL({
        apiKey: "k",
        projectId: "1",
        query: "SELECT 1",
        fetcher: (async () =>
          new Response(huge, {
            status: 200,
            headers: { "content-length": String(huge.length) },
          })) as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });
});
