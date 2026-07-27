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
    expect(csp).toContain("form-action 'self'");
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
