// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  withSecurityHeaders,
} from "../lib/security-headers";

const html = (init?: ResponseInit) =>
  new Response("<!doctype html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });

describe("buildContentSecurityPolicy", () => {
  it("locks framing and object embedding down", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // form-action must include https: — the /login POST redirects to the
    // user's own PDS authorize origin, and Chrome enforces form-action on
    // post-submission redirects. 'self' alone froze sign-in on the error URL.
    expect(csp).toContain("form-action 'self' https:");
    expect(csp).not.toContain("form-action 'self';");
    expect(csp).toContain("default-src 'self'");
  });

  it("allows what the app actually loads, and nothing it does not", () => {
    const csp = buildContentSecurityPolicy();
    // PostHog (optional analytics) reachable in script/connect.
    expect(csp).toContain("https://us.i.posthog.com");
    expect(csp).toContain("https://us-assets.i.posthog.com");
    // Writer markdown embeds remote images; cover picker previews via blob/data.
    expect(csp).toContain("img-src 'self' data: blob: https:");
    // Inline hydration/state scripts + injected styles, but never eval.
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    // Turnstile (optional anti-bot): api.js in script-src, challenge iframe
    // in frame-src. Present unconditionally — harmless while the widget is
    // off, load-bearing the moment the sitekey is set.
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(csp).toMatch(
      /script-src [^;]*https:\/\/challenges\.cloudflare\.com/,
    );
  });

  it("honors a reverse-proxied PostHog host without dropping the defaults", () => {
    const csp = buildContentSecurityPolicy("https://ph.trygoldroad.com");
    expect(csp).toContain("https://ph.trygoldroad.com");
    expect(csp).toContain("https://us.i.posthog.com");
  });
});

describe("withSecurityHeaders", () => {
  it("stamps the baseline onto an HTML document", () => {
    const res = withSecurityHeaders(html(), buildContentSecurityPolicy());
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("omits CSP when passed null (dev) but keeps the other headers", () => {
    const res = withSecurityHeaders(html(), null);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("leaves non-HTML responses untouched (JSON, and /img's own headers)", () => {
    const json = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    const out = withSecurityHeaders(json, buildContentSecurityPolicy());
    expect(out.headers.get("x-frame-options")).toBeNull();
    expect(out.headers.get("content-security-policy")).toBeNull();

    // /img sets its own strict CSP + CORP — must survive verbatim.
    const img = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-type": "image/jpeg",
        "content-security-policy": "default-src 'none'",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
    const imgOut = withSecurityHeaders(img, buildContentSecurityPolicy());
    expect(imgOut.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(imgOut.headers.get("x-frame-options")).toBeNull();
  });

  it("preserves status and body of the wrapped document", async () => {
    const res = withSecurityHeaders(
      html({ status: 200 }),
      buildContentSecurityPolicy(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html>");
  });
});

/**
 * The deploy-freshness stamp. Production once served a week-old build while
 * every health check passed — the site worked, it was merely old — because
 * nothing served said which commit it was. This header is how a check tells
 * "up" from "current".
 */
describe("x-goldroad-version", () => {
  it("stamps the build onto a document", () => {
    const res = withSecurityHeaders(html(), null, "abc123");
    expect(res.headers.get("x-goldroad-version")).toBe("abc123");
  });

  it("omits the header when no build is given", () => {
    const res = withSecurityHeaders(html(), null);
    expect(res.headers.get("x-goldroad-version")).toBeNull();
  });

  /**
   * The reason this lives inside this function rather than at the call site.
   * Non-HTML responses are returned AS THEY CAME, and a handler or cache
   * response may carry immutable headers — so setting a header on the result
   * would throw on every API, feed and image request. Passing the value in
   * keeps the write inside the one branch that reconstructs.
   */
  it("does not touch a non-HTML response, even an immutable one", () => {
    const immutable = new Response("{}", {
      headers: new Headers({ "content-type": "application/json" }),
    });
    Object.defineProperty(immutable.headers, "set", {
      value: () => {
        throw new TypeError("immutable headers");
      },
    });
    expect(() =>
      withSecurityHeaders(immutable, buildContentSecurityPolicy(), "abc123"),
    ).not.toThrow();
    expect(
      withSecurityHeaders(immutable, null, "abc123").headers.get(
        "x-goldroad-version",
      ),
    ).toBeNull();
  });
});
