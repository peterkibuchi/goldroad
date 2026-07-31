// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level Turnstile gating on the two unauthenticated intake endpoints.
 * The D1 layer is mocked (no bindings under vitest) so the assertions can pin
 * the invariant that matters: with TURNSTILE_SECRET set, NO insert happens
 * without a verified token — and without the secret, behavior is exactly the
 * pre-Turnstile passthrough.
 */
const insertedValues = vi.fn();
vi.mock("drizzle-orm/d1", () => ({
  drizzle: () => ({
    insert: () => ({
      values: (row: unknown) => {
        insertedValues(row);
        // Awaitable directly (report) and via onConflictDoNothing (waitlist).
        return Object.assign(Promise.resolve(), {
          onConflictDoNothing: () => Promise.resolve(),
        });
      },
    }),
  }),
}));

import { Route as reportRoute } from "../routes/api.report";
import { Route as waitlistRoute } from "../routes/api.waitlist";
import { env } from "./mocks/cloudflare-workers";
import { handlerOf } from "./support/route-handler";

const postWaitlist = (body: unknown) =>
  handlerOf(
    waitlistRoute,
    "POST",
  )({
    request: new Request("https://trygoldroad.com/api/waitlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify(body),
    }),
  });

const postReport = (body: unknown) =>
  handlerOf(
    reportRoute,
    "POST",
  )({
    request: new Request("https://trygoldroad.com/api/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify(body),
    }),
  });

const WAITLIST_BODY = { email: "writer@example.com", gr_extra: "" };
const REPORT_BODY = {
  url: "https://trygoldroad.com/@writer.example/abc",
  reason: "spam",
  gr_extra: "",
};

function stubSiteverify(success: boolean) {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ success }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  insertedValues.mockClear();
});

afterEach(() => {
  delete env.TURNSTILE_SECRET;
  vi.unstubAllGlobals();
});

describe("without TURNSTILE_SECRET (feature off)", () => {
  it("waitlist accepts exactly as before — no token needed, no fetch spent", async () => {
    const fetcher = stubSiteverify(false);
    const res = await postWaitlist(WAITLIST_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(insertedValues).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("report accepts exactly as before", async () => {
    const fetcher = stubSiteverify(false);
    const res = await postReport(REPORT_BODY);
    expect(res.status).toBe(200);
    expect(insertedValues).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("with TURNSTILE_SECRET set", () => {
  beforeEach(() => {
    env.TURNSTILE_SECRET = "test-secret";
  });

  it("waitlist 400s a token-less submit with the honeypot-indistinguishable body, before any insert", async () => {
    stubSiteverify(true);
    const res = await postWaitlist(WAITLIST_BODY);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("report 400s a token-less submit identically, before any insert", async () => {
    stubSiteverify(true);
    const res = await postReport(REPORT_BODY);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("accepts a verified token and forwards the connecting IP to siteverify", async () => {
    const fetcher = stubSiteverify(true);
    const res = await postWaitlist({
      ...WAITLIST_BODY,
      turnstileToken: "tok",
    });
    expect(res.status).toBe(200);
    expect(insertedValues).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as URLSearchParams).get("remoteip")).toBe("203.0.113.9");
  });

  it("rejects a token siteverify refuses — same indistinguishable 400", async () => {
    stubSiteverify(false);
    const res = await postReport({ ...REPORT_BODY, turnstileToken: "tok" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });
});
