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
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { canonicalRedirect } from "~/lib/origin";
import { serveWithReadCache } from "~/lib/read-cache";
import { runScheduled } from "~/lib/scheduled";
import {
  buildContentSecurityPolicy,
  withSecurityHeaders,
} from "~/lib/security-headers";

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
    // Reading surfaces are served through the edge cache (audit #3); everything
    // else (and any non-reading path) falls straight through.
    const response = await serveWithReadCache(request, () =>
      handler.fetch(request, opts),
    );
    // Security-header baseline on HTML documents (audit #4). Applied after the
    // cache so policy changes take effect on already-cached pages immediately.
    return withSecurityHeaders(response, CSP);
  },
});

// Default export carries BOTH fetch and the Workers Cron handler (audit #6/#7);
// createServerEntry only builds `fetch`, so scheduled is attached here.
export default {
  fetch: entry.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
};
