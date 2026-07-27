// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkTurnstile,
  tokenFromBody,
  verifyTurnstileToken,
} from "../lib/turnstile";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function siteverifyFetch(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkTurnstile — the env gate", () => {
  it("passes every request through when no secret is configured", async () => {
    const fetcher = siteverifyFetch({ success: false });
    // Even a garbage token is irrelevant with the feature off.
    await expect(
      checkTurnstile(undefined, "junk", null, fetcher),
    ).resolves.toBe(true);
    await expect(checkTurnstile("", undefined, null, fetcher)).resolves.toBe(
      true,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a missing/non-string/empty token without spending a fetch", async () => {
    const fetcher = siteverifyFetch({ success: true });
    for (const token of [undefined, null, "", 42, {}]) {
      await expect(checkTurnstile("sec", token, null, fetcher)).resolves.toBe(
        false,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an absurdly oversized token without spending a fetch", async () => {
    const fetcher = siteverifyFetch({ success: true });
    await expect(
      checkTurnstile("sec", "x".repeat(4096), null, fetcher),
    ).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("delegates to siteverify when secret + token are present", async () => {
    const fetcher = siteverifyFetch({ success: true });
    await expect(
      checkTurnstile("sec", "tok", "203.0.113.9", fetcher),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("verifyTurnstileToken — siteverify verdicts", () => {
  it("accepts on success and posts secret/response/remoteip to siteverify", async () => {
    const fetcher = siteverifyFetch({ success: true });
    await expect(
      verifyTurnstileToken("sec", "tok", "203.0.113.9", fetcher),
    ).resolves.toBe(true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SITEVERIFY);
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("sec");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.9");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits remoteip when the connecting IP is unknown", async () => {
    const fetcher = siteverifyFetch({ success: true });
    await verifyTurnstileToken("sec", "tok", null, fetcher);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect((init.body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it("rejects when siteverify says the token failed", async () => {
    const fetcher = siteverifyFetch({
      success: false,
      "error-codes": ["invalid-input-response"],
    });
    await expect(
      verifyTurnstileToken("sec", "tok", null, fetcher),
    ).resolves.toBe(false);
  });

  it("rejects on a non-2xx siteverify answer", async () => {
    const fetcher = siteverifyFetch({}, 503);
    await expect(
      verifyTurnstileToken("sec", "tok", null, fetcher),
    ).resolves.toBe(false);
  });

  it("fails closed on timeout/network error", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(
      verifyTurnstileToken("sec", "tok", null, fetcher),
    ).resolves.toBe(false);
  });

  it("rejects a malformed siteverify body", async () => {
    const fetcher = vi.fn(
      async () => new Response("not json", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      verifyTurnstileToken("sec", "tok", null, fetcher),
    ).resolves.toBe(false);
  });
});

describe("tokenFromBody", () => {
  it("pulls turnstileToken out of a parsed JSON object", () => {
    expect(tokenFromBody({ turnstileToken: "tok", email: "a@b.co" })).toBe(
      "tok",
    );
  });

  it("answers undefined for non-objects and absent fields", () => {
    expect(tokenFromBody(null)).toBeUndefined();
    expect(tokenFromBody("string")).toBeUndefined();
    expect(tokenFromBody({ email: "a@b.co" })).toBeUndefined();
  });
});
