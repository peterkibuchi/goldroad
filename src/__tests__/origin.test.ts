// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CANONICAL_ORIGIN,
  canonicalOrigin,
  canonicalRedirect,
  isCrossSite,
  isLoopbackOrigin,
  LEGACY_ORIGINS,
  ownOrigins,
} from "../lib/origin";

/**
 * The canonical origin is load-bearing three ways at once: it is the OAuth
 * client_id base (origin-bound, permanent), the prefix of
 * every publication URL we mint, and the target of the legacy-hostname 301.
 * Pin it exactly.
 */
describe("constants", () => {
  it("pins the canonical origin", () => {
    expect(CANONICAL_ORIGIN).toBe("https://trygoldroad.com");
  });

  it("keeps the retired workers.dev origin in the legacy list (records referencing it exist)", () => {
    expect(LEGACY_ORIGINS).toContain("https://goldroad.kibuchi.workers.dev");
  });
});

/**
 * The CSRF check every mutating handler shares. It compares against the
 * REQUEST's origin, not CANONICAL_ORIGIN — the worker legitimately answers on
 * preview and loopback hostnames, and a form posted from the page that served
 * it is same-origin on all of them.
 */
describe("isCrossSite", () => {
  const post = (url: string, origin?: string) =>
    new Request(url, {
      method: "POST",
      ...(origin ? { headers: { origin } } : {}),
    });

  it("same-origin and absent Origin pass; foreign Origin fails", () => {
    const url = "https://app.example/api/import";
    expect(isCrossSite(post(url, "https://app.example"))).toBe(false);
    expect(isCrossSite(post(url))).toBe(false);
    expect(isCrossSite(post(url, "https://evil.example"))).toBe(true);
  });

  it("passes on every hostname the worker legitimately answers on", () => {
    for (const origin of [
      "https://trygoldroad.com",
      "https://abc12345-goldroad.kibuchi.workers.dev",
      "http://127.0.0.1:3000",
    ]) {
      expect(isCrossSite(post(`${origin}/api/publish`, origin))).toBe(false);
    }
  });

  it("refuses a sibling hostname of our own zone (Origin is exact, not suffixed)", () => {
    expect(
      isCrossSite(
        post("https://trygoldroad.com/api/publish", "https://evil.example"),
      ),
    ).toBe(true);
  });
});

describe("isLoopbackOrigin", () => {
  it("accepts localhost, 127.0.0.1 and [::1]", () => {
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:3000")).toBe(true);
  });

  it("rejects production hostnames", () => {
    expect(isLoopbackOrigin("https://trygoldroad.com")).toBe(false);
    expect(isLoopbackOrigin("https://goldroad.kibuchi.workers.dev")).toBe(
      false,
    );
  });
});

describe("canonicalOrigin", () => {
  it("keeps loopback request origins (dev loopback OAuth must stay on 127.0.0.1)", () => {
    expect(canonicalOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(canonicalOrigin("http://localhost:8788")).toBe(
      "http://localhost:8788",
    );
  });

  it("canonicalizes every production hostname — workers.dev, previews, even the canonical host itself", () => {
    expect(canonicalOrigin("https://goldroad.kibuchi.workers.dev")).toBe(
      CANONICAL_ORIGIN,
    );
    expect(
      canonicalOrigin("https://abc12345-goldroad.kibuchi.workers.dev"),
    ).toBe(CANONICAL_ORIGIN);
    expect(canonicalOrigin("https://trygoldroad.com")).toBe(CANONICAL_ORIGIN);
  });
});

describe("ownOrigins", () => {
  it("in production: canonical + legacy, never the serving hostname", () => {
    const origins = ownOrigins("https://goldroad.kibuchi.workers.dev");
    expect(origins).toContain(CANONICAL_ORIGIN);
    expect(origins).toContain("https://goldroad.kibuchi.workers.dev"); // via LEGACY_ORIGINS
    expect(ownOrigins("https://trygoldroad.com")).toEqual([
      CANONICAL_ORIGIN,
      ...LEGACY_ORIGINS,
    ]);
  });

  it("in dev: the loopback origin too, so locally created records stay ours", () => {
    const origins = ownOrigins("http://127.0.0.1:3000");
    expect(origins).toContain("http://127.0.0.1:3000");
    expect(origins).toContain(CANONICAL_ORIGIN);
    expect(origins).toContain("https://goldroad.kibuchi.workers.dev");
  });
});

describe("canonicalRedirect", () => {
  const redirectFor = (url: string) =>
    canonicalRedirect(new Request(url, { method: "GET" }));

  it("301s the legacy production hostname to the same path + query on trygoldroad.com", () => {
    const res = redirectFor(
      "https://goldroad.kibuchi.workers.dev/@writer.example/3lyk73wxnok2f?a=1&b=2",
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe(
      "https://trygoldroad.com/@writer.example/3lyk73wxnok2f?a=1&b=2",
    );
  });

  it("301s the legacy root to the canonical root", () => {
    const res = redirectFor("https://goldroad.kibuchi.workers.dev/");
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("https://trygoldroad.com/");
  });

  it("covers API and OAuth paths (it runs in the worker entry, before routing)", () => {
    const res = redirectFor(
      "https://goldroad.kibuchi.workers.dev/oauth/client-metadata.json",
    );
    expect(res?.headers.get("location")).toBe(
      "https://trygoldroad.com/oauth/client-metadata.json",
    );
  });

  it("serves the canonical hostname untouched", () => {
    expect(redirectFor("https://trygoldroad.com/")).toBeNull();
    expect(redirectFor("https://trygoldroad.com/write?edit=3abc")).toBeNull();
  });

  it("serves dev loopback untouched", () => {
    expect(redirectFor("http://127.0.0.1:3000/")).toBeNull();
    expect(redirectFor("http://localhost:3000/dashboard")).toBeNull();
  });

  it("serves versioned preview hostnames untouched (PR previews must stay viewable)", () => {
    expect(
      redirectFor("https://abc12345-goldroad.kibuchi.workers.dev/write"),
    ).toBeNull();
  });

  it("matches on hostname only — plain http on the canonical host is served (wrangler dev presents the zone host over http; https upgrades belong to the Cloudflare edge)", () => {
    expect(redirectFor("http://trygoldroad.com/write")).toBeNull();
  });
});
