/**
 * Worker-side error tracking: exceptions are reported to PostHog as
 * `$exception` events over one plain HTTP POST — no SDK dependency (posthog-js
 * is a browser SDK; a server SDK is overkill for a single capture call). The
 * send rides `waitUntil`, so reporting never delays or blocks the response.
 *
 * `withExceptionCapture` reports UNHANDLED exceptions at the top of the fetch
 * chain and rethrows, so the platform's own handling is unchanged.
 * `captureHandledFailure` reports a failure the code caught and degraded from,
 * marked `mechanism.handled: true` so it stays filterable from real crashes.
 *
 * Gated on the same key as client analytics (VITE_PUBLIC_POSTHOG_KEY): no
 * key, no capture. Events carry `app_env` (hostname-derived, same convention
 * as ~/lib/posthog) so production exceptions are filterable from dev noise.
 *
 * Privacy: no user identity — a fixed distinct_id groups all worker
 * exceptions, and only the request path + method are attached (no headers,
 * no cookies, no bodies). Messages go through `safeMessage` first: a failed
 * query's message carries its bound params, which for the OAuth session store
 * are a writer's tokens and DPoP key.
 */
import { isNotFound, isRedirect } from "@tanstack/react-router";

import { appEnvForHostname } from "~/lib/posthog";
import { waitUntil } from "cloudflare:workers";

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const MAX_MESSAGE_CHARS = 200;

/** First line only (drizzle puts `params:` on the next one), with DIDs,
 * JWTs and long token-like runs redacted, then capped. */
export function safeMessage(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine
    .replace(/did:[a-z]+:[A-Za-z0-9._:%-]+/g, "did:…")
    .replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, "[token]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
    .slice(0, MAX_MESSAGE_CHARS);
}

/** Stacks are bounded so a pathological error can't bloat the event. */
const MAX_STACK_CHARS = 4000;
const MAX_STACK_FRAMES = 50;

/** One stack frame in PostHog's raw-stacktrace shape (error-tracking schema:
 * $exception_list[].stacktrace = { type: "raw", frames } — a bare stack
 * string is not displayed by the UI). `platform: "custom"` marks manually
 * constructed frames. */
type RawFrame = {
  platform: "custom";
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
};

/**
 * Parses a V8-style stack string ("    at fn (file:line:col)") into PostHog
 * raw frames, reversed to the schema's oldest-call-first order. Best-effort:
 * unparseable lines are skipped, and an empty result means the exception
 * ships without a stacktrace (type/value still display and group).
 */
export function parseStackFrames(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  for (const line of stack.slice(0, MAX_STACK_CHARS).split("\n")) {
    const at = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/);
    if (!at) continue;
    frames.push({
      platform: "custom",
      ...(at[1] ? { function: at[1] } : {}),
      filename: at[2],
      lineno: Number(at[3]),
      colno: Number(at[4]),
      in_app: true,
    });
    if (frames.length >= MAX_STACK_FRAMES) break;
  }
  return frames.reverse();
}

export type ExceptionCaptureConfig = {
  /** PostHog project API key; absent/empty = capture is fully off. */
  apiKey?: string;
  /** Ingestion host override (reverse-proxied setups); defaults to US cloud. */
  host?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
};

export type CaptureMechanism = {
  /** True = the code caught this and degraded from it; false = it escaped to
   * the platform. PostHog surfaces the distinction, and it is the whole
   * difference between "the site is down" and "one section is missing". */
  handled?: boolean;
};

/** The `$exception` capture body, PostHog error-tracking shape: an
 * $exception_list entry (type/value/mechanism) plus our standard app_env. */
export function buildExceptionEvent(
  error: unknown,
  request: Request,
  apiKey: string,
  mechanism: CaptureMechanism = {},
) {
  const url = new URL(request.url);
  const err = error instanceof Error ? error : null;
  const frames = err?.stack ? parseStackFrames(err.stack) : [];
  return {
    api_key: apiKey,
    event: "$exception",
    distinct_id: "goldroad-worker",
    timestamp: new Date().toISOString(),
    properties: {
      app_env: appEnvForHostname(url.hostname),
      $exception_list: [
        {
          type: err?.name ?? "Error",
          value: safeMessage(err ? err.message : String(error)),
          mechanism: { handled: mechanism.handled === true, synthetic: false },
          ...(frames.length > 0
            ? { stacktrace: { type: "raw" as const, frames } }
            : {}),
        },
      ],
      path: url.pathname,
      method: request.method,
      runtime: "cloudflare-worker",
    },
  };
}

/**
 * Fire-and-forget capture. Returns whether a send was scheduled (false when
 * no key is configured or event building itself failed). Never throws:
 * telemetry must never shadow the original exception, so both the build and
 * the POST are fully guarded.
 */
export function captureServerException(
  error: unknown,
  request: Request,
  schedule: (promise: Promise<unknown>) => void,
  config: ExceptionCaptureConfig,
  mechanism: CaptureMechanism = {},
): boolean {
  if (!config.apiKey) return false;
  try {
    const host = (config.host ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
    const body = JSON.stringify(
      buildExceptionEvent(error, request, config.apiKey, mechanism),
    );
    const send = config.fetchFn ?? fetch;
    schedule(
      send(`${host}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }).catch(() => {
        // A failed report is only a lost data point.
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The build-time PostHog vars, shared by server.ts and captureHandledFailure.
 */
export const BUILD_TIME_CAPTURE_CONFIG: ExceptionCaptureConfig = {
  apiKey: import.meta.env.VITE_PUBLIC_POSTHOG_KEY || undefined,
  host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST || undefined,
};

/**
 * Report a failure the code CAUGHT and degraded from — the kind that by
 * design never reaches `withExceptionCapture`. Same gate, same transport,
 * `handled: true`.
 *
 * Deliberately not called from every catch: most degradations are logged and
 * self-healing, and a stream of events would bury the few that change a
 * decision. Reserved for failures a maintainer would want a date on.
 *
 * `waitUntil` comes from `cloudflare:workers` rather than a handler's
 * ExecutionContext: callers sit deep inside route handlers where no ctx is
 * in scope, and the send has to outlive the response it degraded. Injectable
 * for tests, like every other seam in this module.
 */
export function captureHandledFailure(
  error: unknown,
  request: Request,
  config: ExceptionCaptureConfig = BUILD_TIME_CAPTURE_CONFIG,
  schedule: (promise: Promise<unknown>) => void = waitUntil,
): boolean {
  return captureServerException(error, request, schedule, config, {
    handled: true,
  });
}

/**
 * Report a server function that threw. Start turns the throw into an error
 * response, so it never escapes to `withExceptionCapture`. Redirects and
 * notFound travel as throws too, but they're how a handler answers, not
 * failures, so they're skipped.
 */
export function captureServerFnError(
  error: unknown,
  request: Request,
  config: ExceptionCaptureConfig = BUILD_TIME_CAPTURE_CONFIG,
  schedule: (promise: Promise<unknown>) => void = waitUntil,
): boolean {
  if (isRedirect(error) || isNotFound(error)) return false;
  return captureServerException(error, request, schedule, config);
}

/**
 * Wraps a fetch handler: exceptions are captured (via waitUntil) and
 * rethrown, so the runtime still answers with its usual 500 — behavior is
 * byte-identical to the unwrapped handler except for the telemetry.
 */
export function withExceptionCapture(
  handler: (request: Request) => Promise<Response> | Response,
  config: ExceptionCaptureConfig,
): (
  request: Request,
  ctx: { waitUntil(promise: Promise<unknown>): void },
) => Promise<Response> {
  return async (request, ctx) => {
    try {
      return await handler(request);
    } catch (error) {
      captureServerException(error, request, (p) => ctx.waitUntil(p), config);
      throw error;
    }
  };
}
