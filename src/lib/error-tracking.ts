/**
 * Worker-side error tracking: unhandled exceptions from the fetch handler are
 * reported to PostHog as `$exception` events over one plain HTTP POST — no
 * SDK dependency (posthog-js is a browser SDK; a server SDK is overkill for
 * a single capture call). The send rides `waitUntil`, so reporting never
 * delays or blocks the response, and the error is RETHROWN afterwards — the
 * platform's error handling (the 500 the visitor sees, the log line) is
 * exactly what it was before this existed.
 *
 * Gated on the same key as client analytics (VITE_PUBLIC_POSTHOG_KEY): no
 * key, no capture. Events carry `app_env` (hostname-derived, same convention
 * as ~/lib/posthog) so production exceptions are filterable from dev noise.
 *
 * Privacy: no user identity — a fixed distinct_id groups all worker
 * exceptions, and only the request path + method are attached (no headers,
 * no cookies, no bodies).
 */
import { appEnvForHostname } from "~/lib/posthog";

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Stacks are bounded so a pathological error can't bloat the event. */
const MAX_STACK_CHARS = 4000;

export type ExceptionCaptureConfig = {
  /** PostHog project API key; absent/empty = capture is fully off. */
  apiKey?: string;
  /** Ingestion host override (reverse-proxied setups); defaults to US cloud. */
  host?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
};

/** The `$exception` capture body, PostHog error-tracking shape: an
 * $exception_list entry (type/value/mechanism) plus our standard app_env. */
export function buildExceptionEvent(
  error: unknown,
  request: Request,
  apiKey: string,
) {
  const url = new URL(request.url);
  const err = error instanceof Error ? error : null;
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
          value: err ? err.message : String(error),
          mechanism: { handled: false, synthetic: false },
        },
      ],
      path: url.pathname,
      method: request.method,
      runtime: "cloudflare-worker",
      ...(err?.stack ? { stack: err.stack.slice(0, MAX_STACK_CHARS) } : {}),
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
  waitUntil: (promise: Promise<unknown>) => void,
  config: ExceptionCaptureConfig,
): boolean {
  if (!config.apiKey) return false;
  try {
    const host = (config.host ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
    const body = JSON.stringify(
      buildExceptionEvent(error, request, config.apiKey),
    );
    const send = config.fetchFn ?? fetch;
    waitUntil(
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
