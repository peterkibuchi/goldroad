// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  buildExceptionEvent,
  captureHandledFailure,
  captureServerException,
  DEFAULT_POSTHOG_HOST,
  parseStackFrames,
  safeMessage,
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
    expect(event.properties.$exception_list[0]).toMatchObject({
      type: "TypeError",
      value: "boom",
      mechanism: { handled: false, synthetic: false },
    });
    expect(event.properties.path).toBe("/write");
    expect(event.properties.method).toBe("GET");
    // A real Error carries a structured raw stacktrace (the shape PostHog's
    // error-tracking UI displays — a bare stack string would be ignored).
    const { stacktrace } = event.properties.$exception_list[0];
    expect(stacktrace?.type).toBe("raw");
    expect(stacktrace?.frames.length).toBeGreaterThan(0);
    expect(stacktrace?.frames[0]).toMatchObject({
      platform: "custom",
      in_app: true,
    });
  });

  it("can express a HANDLED failure — the degradation paths need this", () => {
    const event = buildExceptionEvent(new Error("upstream"), REQUEST, "k", {
      handled: true,
    });
    expect(event.properties.$exception_list[0].mechanism).toEqual({
      handled: true,
      synthetic: false,
    });
  });

  it("handles non-Error throws (no stacktrace, stringified value)", () => {
    const event = buildExceptionEvent("thrown string", REQUEST, "phc_key");
    expect(event.properties.$exception_list[0]).toMatchObject({
      type: "Error",
      value: "thrown string",
    });
    expect("stacktrace" in event.properties.$exception_list[0]).toBe(false);
  });

  it("omits the stacktrace when the stack is unparseable garbage", () => {
    const err = new Error("deep");
    err.stack = "x".repeat(100_000);
    const event = buildExceptionEvent(err, REQUEST, "phc_key");
    expect("stacktrace" in event.properties.$exception_list[0]).toBe(false);
  });
});

describe("parseStackFrames — V8 stack string → PostHog raw frames", () => {
  it("parses named and anonymous frames, oldest call first", () => {
    const stack = [
      "TypeError: boom",
      "    at inner (/src/lib/a.ts:10:5)",
      "    at /src/routes/b.ts:20:15",
    ].join("\n");
    const frames = parseStackFrames(stack);
    expect(frames).toEqual([
      // reversed: the throw site comes last, per the schema's ordering
      {
        platform: "custom",
        filename: "/src/routes/b.ts",
        lineno: 20,
        colno: 15,
        in_app: true,
      },
      {
        platform: "custom",
        function: "inner",
        filename: "/src/lib/a.ts",
        lineno: 10,
        colno: 5,
        in_app: true,
      },
    ]);
  });

  it("caps the frame count so a pathological stack can't bloat the event", () => {
    const stack = Array.from(
      { length: 500 },
      (_, i) => `    at fn${i} (/src/x.ts:${i + 1}:1)`,
    ).join("\n");
    expect(parseStackFrames(stack).length).toBeLessThanOrEqual(50);
  });

  it("returns no frames for a stackless or garbled string", () => {
    expect(parseStackFrames("")).toEqual([]);
    expect(parseStackFrames("not a stack at all")).toEqual([]);
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

describe("safeMessage — nothing secret leaves the worker", () => {
  it("drops a failed query's params line, where session tokens live", () => {
    const leaked =
      'Failed query: insert into "oauth_kv" ("key","value") values (?, ?)\nparams: sess:did:plc:abc123,{"access_token":"eyJhbGciOi.eyJzdWIi.c2ln","refresh_token":"' +
      "r".repeat(40) +
      '"}';
    expect(safeMessage(leaked)).toBe(
      'Failed query: insert into "oauth_kv" ("key","value") values (?, ?)',
    );
  });

  it("redacts DIDs, JWTs and long token-like runs on the first line", () => {
    expect(
      safeMessage(
        `restore failed for did:plc:wdbi6uankwl65bj54x2g5eed with eyJhbGciOi.eyJzdWIi.c2ln and ${"a".repeat(40)}`,
      ),
    ).toBe("restore failed for did:… with [token] and [redacted]");
  });

  it("caps the length", () => {
    expect(safeMessage("x ".repeat(500))).toHaveLength(200);
  });

  it("is what the event carries", () => {
    const event = buildExceptionEvent(
      new Error("boom\nparams: secret"),
      new Request("https://trygoldroad.com/api/publish"),
      "phc_test",
    );
    expect(event.properties.$exception_list[0].value).toBe("boom");
  });
});

describe("captureHandledFailure — degradations reach the tracker too", () => {
  it("sends the same event marked handled, so crashes stay filterable", async () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    const sent = captureHandledFailure(
      new Error("session restore failed"),
      REQUEST,
      { apiKey: "phc_key", fetchFn },
      ctx.waitUntil,
    );
    expect(sent).toBe(true);
    await Promise.all(scheduled);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as {
      properties: {
        $exception_list: {
          value: string;
          mechanism: { handled: boolean };
        }[];
      };
    };
    expect(body.properties.$exception_list[0].value).toBe(
      "session restore failed",
    );
    expect(body.properties.$exception_list[0].mechanism.handled).toBe(true);
  });

  it("is off without a key, exactly like the unhandled path", () => {
    const fetchFn = okFetch();
    const { ctx, scheduled } = makeCtx();
    expect(
      captureHandledFailure(
        new Error("x"),
        REQUEST,
        { fetchFn },
        ctx.waitUntil,
      ),
    ).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
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
