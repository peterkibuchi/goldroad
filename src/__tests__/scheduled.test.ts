// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  purgeExpiredOauthKv,
  reportFailures,
  selfCheck,
} from "../lib/scheduled";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("purgeExpiredOauthKv — the purge query (audit #7)", () => {
  it("deletes oauth_kv rows with a set, past expiry — and never null ones", () => {
    // Build-only drizzle instance; .toSQL() never touches the (empty) client.
    // biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
    const db = drizzle({} as any);
    const now = 1_727_000_000_000;
    const { sql, params } = purgeExpiredOauthKv(db, now).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "oauth_kv"');
    expect(sql).toContain("expires_at");
    // The condition is: expires_at IS NOT NULL AND expires_at <= <now>.
    expect(sql.toLowerCase()).toContain("is not null");
    expect(params).toContain(now);
  });
});

describe("selfCheck — core invariants (audit #6)", () => {
  const origin = "https://trygoldroad.com";

  function stubFetch(
    root: () => Response,
    metadata: () => Response = () =>
      Response.json({
        client_id: "https://trygoldroad.com/oauth/client-metadata.json",
      }),
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("client-metadata")) return metadata();
        return root();
      }),
    );
  }

  it("returns no failures when the site is healthy", async () => {
    stubFetch(() => new Response("<html>Goldroad</html>", { status: 200 }));
    expect(await selfCheck(origin)).toEqual([]);
  });

  it("flags a non-200 landing page", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    const failures = await selfCheck(origin);
    expect(failures.some((f) => f.includes("GET / -> 503"))).toBe(true);
  });

  it("flags a wrong OAuth client_id", async () => {
    stubFetch(
      () => new Response("<html>Goldroad</html>", { status: 200 }),
      () => Response.json({ client_id: "https://evil.example/x" }),
    );
    const failures = await selfCheck(origin);
    expect(failures.some((f) => f.includes("client_id"))).toBe(true);
  });
});

describe("reportFailures — alert only when a webhook AND failures exist", () => {
  it("POSTs when both are present", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures("https://hook.example", ["down"])).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("no-ops without a webhook (WEBHOOK_URL absent)", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures(undefined, ["down"])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops when there are no failures", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures("https://hook.example", [])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
