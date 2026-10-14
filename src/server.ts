/**
 * Custom worker entry: hostname canonicalization in front of the TanStack
 * Start handler, so EVERY route (pages, API, OAuth endpoints) 301s from
 * legacy hostnames (goldroad.kibuchi.workers.dev) to https://trygoldroad.com
 * before any routing happens. Dev loopback and versioned preview hostnames
 * pass through — see ~/lib/origin.
 *
 * Referenced by wrangler.jsonc `main` (was the package default
 * "@tanstack/react-start/server-entry", which this wraps).
 */

/** Stamped by vite.config.ts from WORKERS_CI_COMMIT_SHA; "dev" off CI. */
declare const __BUILD_SHA__: string;
/** Unique per build (vite.config.ts); keys the edge cache's stored pages. */
declare const __BUILD_ID__: string;

import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import {
  BUILD_TIME_CAPTURE_CONFIG,
  withExceptionCapture,
} from "~/lib/error-tracking";
import { canonicalRedirect } from "~/lib/origin";
import { serveWithReadCache } from "~/lib/read-cache";
import { runScheduled } from "~/lib/scheduled";
import {
  buildContentSecurityPolicy,
  withSecurityHeaders,
} from "~/lib/security-headers";
import { waitUntil } from "cloudflare:workers";

// CSP only in production: Vite dev needs 'unsafe-eval' + ws: for HMR, so a
// strict policy would white-screen `pnpm dev`. Verify the prod CSP against the
// built worker (`vite preview`) instead. The other headers are safe in both.
const CSP = import.meta.env.PROD
  ? buildContentSecurityPolicy(
      import.meta.env.VITE_PUBLIC_POSTHOG_HOST || undefined,
    )
  : null;

const entry = createServerEntry({
  async fetch(request, opts) {
    const redirect = canonicalRedirect(request);
    if (redirect) return redirect;
    // Reading surfaces and marketing pages are served through the edge
    // cache; everything else falls straight through.
    const response = await serveWithReadCache(
      request,
      () => handler.fetch(request, opts),
      waitUntil,
      __BUILD_ID__,
    );
    // Security-header baseline on HTML documents. Applied after the
    // cache so policy changes take effect on already-cached pages immediately.
    return withSecurityHeaders(response, CSP, __BUILD_SHA__);
  },
});

// Error tracking around the whole entry (same key gate as client analytics):
// an unhandled exception is reported to PostHog on ctx.waitUntil — never
// blocking the response — then rethrown, so the platform's 500 handling is
// unchanged. Handled degradations report themselves at their catch sites
// through the same config (see ~/lib/error-tracking).
const handleFetch = withExceptionCapture(
  (request) => entry.fetch(request),
  BUILD_TIME_CAPTURE_CONFIG,
);

// Default export carries BOTH fetch and the Workers Cron handler;
// createServerEntry only builds `fetch`, so scheduled is attached here.
export default {
  async fetch(
    request: Request,
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleFetch(request, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // The self-check calls our own handler in-process: a fetch of our own
    // hostname from inside the Worker is routed to the zone's origin, past
    // the Worker, so it would test something else.
    ctx.waitUntil(runScheduled(env, (request) => handleFetch(request, ctx)));
  },
};
