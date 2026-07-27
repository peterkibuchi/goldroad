// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  buildExceptionEvent,
  captureServerException,
  DEFAULT_POSTHOG_HOST,
  withExceptionCapture,
} from "../lib/error-tracking";

const REQUEST = new Request("https://trygoldroad.com/write", {
  method: "GET",
});

function makeCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    ctx: { waitUntil: (p: Promise<unknown>) => scheduled.push(p) },
  };
}

function okFetch() {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
  );
}

describe("buildExceptionEvent — the $exception body", () => {
  it("shapes an Error with type/value/mechanism, app_env, and request coords", () => {
    const event = buildExceptionEvent(
      new TypeError("boom"),
      REQUEST,
      "phc_key",
    );
    expect(event.api_key).toBe("phc_key");
    expect(event.event).toBe("$exception");
    expect(event.properties.app_env).toBe("production");
    expect(event.properties.$exception_list).toEqual([
      {
        type: "TypeError",
        value: "boom",
        mechanism: { handled: false, synthetic: false },
      },
    ]);
    expect(event.properties.path).toBe("/write");
    expect(event.properties.method).toBe("GET");
    expect(String(event.properties.stack)).toContain("boom");
  });

  it("handles non-Error throws (no stack, stringified value)", () => {
    const event = buildExceptionEvent("thrown string", REQUEST, "phc_key");
    expect(event.properties.$exception_list[0]).toMatchObject({
      type: "Error",
      value: "thrown string",
    });
    expect("stack" in event.properties).toBe(false);
  });

  it("bounds the stack so a pathological error can't bloat the event", () => {
    const err = new Error("deep");
    err.stack = "x".repeat(100_000);
    const event = buildExceptionEvent(err, REQUEST, "phc_key");
    expect(String(event.properties.stack).length).toBeLessThanOrEqual(4000);
  });
});

describe("captureServerException — gating and delivery", () => {
  it("POSTs to the capture endpoint via waitUntil when a key is set", async () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    const sent = captureServerException(
      new Error("boom"),
      REQUEST,
      ctx.waitUntil,
      { apiKey: "phc_key", fetchFn },
    );
    expect(sent).toBe(true);
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${DEFAULT_POSTHOG_HOST}/capture/`);
    const body = JSON.parse(String(init?.body)) as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(body.event).toBe("$exception");
    expect(body.properties.app_env).toBe("production");
  });

  it("honors a host override, trailing slash tolerated", async () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    captureServerException(new Error("boom"), REQUEST, ctx.waitUntil, {
      apiKey: "phc_key",
      host: "https://ph.example.com/",
      fetchFn,
    });
    await Promise.all(scheduled);
    expect(fetchFn.mock.calls[0][0]).toBe("https://ph.example.com/capture/");
  });

  it("is fully off without a key: no fetch, nothing scheduled", () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    const sent = captureServerException(
      new Error("boom"),
      REQUEST,
      ctx.waitUntil,
      { fetchFn },
    );
    expect(sent).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("swallows a failed report — telemetry never throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const { ctx, scheduled } = makeCtx();
    captureServerException(new Error("boom"), REQUEST, ctx.waitUntil, {
      apiKey: "phc_key",
      fetchFn,
    });
    await expect(scheduled[0]).resolves.toBeUndefined();
  });
});

describe("withExceptionCapture — the fetch wrapper", () => {
  it("passes successful responses through untouched, capturing nothing", async () => {
    const fetchFn = okFetch();
    const { ctx } = makeCtx();
    const wrapped = withExceptionCapture(
      async () => new Response("ok", { status: 200 }),
      { apiKey: "phc_key", fetchFn },
    );
    const res = await wrapped(REQUEST, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("captures then RETHROWS the original error — the platform 500 path is unchanged", async () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    const boom = new Error("handler exploded");
    const wrapped = withExceptionCapture(
      async () => {
        throw boom;
      },
      { apiKey: "phc_key", fetchFn },
    );
    await expect(wrapped(REQUEST, ctx)).rejects.toBe(boom);
    await Promise.all(scheduled);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as {
      properties: { $exception_list: { value: string }[] };
    };
    expect(body.properties.$exception_list[0].value).toBe("handler exploded");
  });

  it("without a key still rethrows and never captures", async () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    const wrapped = withExceptionCapture(
      async () => {
        throw new Error("boom");
      },
      { fetchFn },
    );
    await expect(wrapped(REQUEST, ctx)).rejects.toThrow("boom");
    expect(scheduled).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
