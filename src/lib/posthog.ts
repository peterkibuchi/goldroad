/**
 * PostHog, cookieless: `persistence: "memory"` stores
 * nothing on the visitor's device — no cookies, no localStorage, no consent
 * banner needed. Anonymous ids therefore reset per pageload; fine for
 * product-usage signal, which is all we want.
 *
 * Init is gated on VITE_PUBLIC_POSTHOG_KEY: without it every call here is a
 * graceful no-op. One PostHog project serves dev, preview and production —
 * every event is stamped with an `app_env` property (hostname-derived) via
 * `before_send`, which runs on EVERY event including the automatic first
 * $pageview, so the stamp can never race init ordering. Insights filter
 * `app_env = production`; dev/preview events exist for verification.
 *
 * The SDK is dynamically imported so reader pages don't pay for it in the
 * critical bundle — events fired before it loads are queued on the promise.
 *
 * Events (beyond `defaults`-captured pageviews): waitlist_joined,
 * post_published, post_announced. Property policy: nothing beyond DID/handle
 * + the post rkey (public data — the rkey is already in the post's URL).
 */
import { env } from "#/env";

type PostHogClient = typeof import("posthog-js")["default"];

/** Which deployment produced an event. Hostname-based: the one build (and
 * PostHog key) is shared across environments, so the URL is the truth. */
export function appEnvForHostname(
  hostname: string,
): "production" | "preview" | "dev" {
  if (hostname === "trygoldroad.com") return "production";
  if (hostname.endsWith("workers.dev")) return "preview";
  return "dev";
}

/** `before_send` stamp: attaches app_env to an outgoing event (mutating, as
 * the posthog-js hook contract expects). Exported for the unit test that pins
 * "the first captured event carries app_env". */
export function stampAppEnv<
  T extends { properties: Record<string, unknown> } | null,
>(event: T, hostname: string): T {
  if (event) event.properties.app_env = appEnvForHostname(hostname);
  return event;
}

let loading: Promise<PostHogClient | null> | null = null;

function load(): Promise<PostHogClient | null> {
  const key = env.VITE_PUBLIC_POSTHOG_KEY;
  if (typeof window === "undefined" || !key) return Promise.resolve(null);
  loading ??= import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: env.VITE_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      // 2025-05-24 defaults: history-change pageviews (SPA navigations count).
      defaults: "2025-05-24",
      persistence: "memory",
      before_send: (event) => stampAppEnv(event, window.location.hostname),
    });
    return posthog;
  });
  return loading;
}

/** Starts pageview capture. Call once from the root shell; safe to repeat. */
export function initPostHog(): void {
  void load();
}

/** Fire-and-forget custom event; no-op without a key. */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  void load().then((posthog) => posthog?.capture(event, properties));
}
