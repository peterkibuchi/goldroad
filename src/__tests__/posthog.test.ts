// @vitest-environment node
import { describe, expect, it } from "vitest";

import { appEnvForHostname, stampAppEnv } from "../lib/posthog";

/**
 * One PostHog project serves every environment; the app_env property is the
 * only thing separating production metrics from dev/preview noise. It is
 * attached in `before_send`, which posthog-js runs on EVERY outgoing event —
 * including the automatic first $pageview — so no init-ordering can produce
 * an unstamped event. These tests pin both the derivation and the stamp.
 */
describe("appEnvForHostname", () => {
  it("maps the canonical host to production", () => {
    expect(appEnvForHostname("trygoldroad.com")).toBe("production");
  });

  it("maps workers.dev hostnames (legacy prod + versioned previews) to preview", () => {
    expect(appEnvForHostname("goldroad.kibuchi.workers.dev")).toBe("preview");
    expect(appEnvForHostname("abc12345-goldroad.kibuchi.workers.dev")).toBe(
      "preview",
    );
  });

  it("maps loopback (and anything else) to dev", () => {
    expect(appEnvForHostname("127.0.0.1")).toBe("dev");
    expect(appEnvForHostname("localhost")).toBe("dev");
  });
});

describe("stampAppEnv (the before_send hook)", () => {
  it("stamps app_env onto the first event — an initial $pageview", () => {
    const firstPageview = {
      event: "$pageview",
      properties: {} as Record<string, unknown>,
    };
    const out = stampAppEnv(firstPageview, "trygoldroad.com");
    expect(out?.properties.app_env).toBe("production");
  });

  it("stamps custom events and preserves their existing properties", () => {
    const event = {
      event: "post_published",
      properties: { rkey: "3lyk73wxnok2f" } as Record<string, unknown>,
    };
    const out = stampAppEnv(event, "abc12345-goldroad.kibuchi.workers.dev");
    expect(out?.properties).toMatchObject({
      rkey: "3lyk73wxnok2f",
      app_env: "preview",
    });
  });

  it("passes through null (posthog-js uses null to drop events)", () => {
    expect(stampAppEnv(null, "trygoldroad.com")).toBeNull();
  });
});
