/**
 * Account deletion — the destructive action beneath "Your data" on /settings.
 * Purges OUR copies only: drafts, import ledger + rate-limit rows, the daily
 * follower snapshots, any scheduled posts (a pending one is an instruction to
 * publish, and must not outlive the account), their account preferences, and the
 * D1-side OAuth session, then clears the session cookie. Session-authed POST, re-verified here (never trust a
 * client-supplied identity for a delete).
 *
 * ARCHITECTURAL NOTE, worth restating at the one place that could get it
 * wrong: this does NOT touch the writer's published posts or their Bluesky
 * announces — those are records in the writer's own atproto repo, not ours,
 * and this handler never issues a single atproto write. Deleting a Goldroad
 * account removes Goldroad's bookkeeping about that account; the writer's
 * identity and published work are theirs regardless of what we do here.
 *
 * Idempotent: every delete here is a bare `WHERE did = ?` (drizzle's
 * `.returning()` on zero matched rows is a no-op, not an error), so a
 * double-submit (e.g. a retried request after a flaked redirect) costs
 * nothing extra — the second call just deletes zero rows and still clears
 * the cookie.
 *
 * CSRF: a real <form method="post"> navigation (like ~/routes/logout and
 * ~/routes/api.publish), so SameSite=Lax already keeps the session cookie off
 * cross-site submissions. The Origin check below is the same one-header
 * defense-in-depth (isCrossSite, ~/lib/origin) every mutating handler
 * applies — and this action is irreversible.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { isDid } from "~/lib/atproto";
import { readLiveSessionDid } from "~/lib/live-session";
import { createOAuthClient } from "~/lib/oauth";
import { isCrossSite } from "~/lib/origin";
import {
  deleteDraftsForDid,
  deleteFollowerSnapshotsForDid,
  deleteImportFetchesForDid,
  deleteImportItemsForDid,
  deleteOAuthSessionForDid,
  deleteScheduledPostsForDid,
  deleteWriterPrefsForDid,
} from "~/lib/rights-store";
import { clearSessionCookies } from "~/lib/session";
import { env } from "cloudflare:workers";

/** Failures redirect back to /settings with the existing error-message
 * system (same pattern as ~/routes/api.publish's backToSettings), rather
 * than surfacing a bare status-code response to a real page navigation. */
function backToSettings(error: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/settings?error=${encodeURIComponent(error)}` },
  });
}

export const Route = createFileRoute("/api/account/delete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const clearCookies = clearSessionCookies(url.protocol === "https:");

        if (isCrossSite(request)) {
          return backToSettings("delete_account_failed");
        }
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did)) {
          return backToSettings("delete_account_failed");
        }

        const db = drizzle(env.DB);
        // Our D1 rows first (each independently a no-op if already gone) —
        // these are the writer's data, so they're deleted unconditionally,
        // not best-effort.
        await Promise.all([
          deleteDraftsForDid(db, did),
          deleteImportItemsForDid(db, did),
          deleteImportFetchesForDid(db, did),
          deleteFollowerSnapshotsForDid(db, did),
          deleteScheduledPostsForDid(db, did),
          deleteWriterPrefsForDid(db, did),
        ]);

        // Upstream token revocation is best-effort (same posture as
        // ~/routes/logout): a failed revoke must never block the account
        // deletion the writer asked for. The direct D1 delete right after is
        // NOT best-effort — see ~/lib/rights-store's deleteOAuthSessionForDid
        // doc comment for why revoke() alone isn't a sufficient guarantee.
        try {
          await createOAuthClient(url.origin).revoke(did);
        } catch (err) {
          console.warn("token revoke failed during account deletion", err);
        }
        await deleteOAuthSessionForDid(db, did);

        const headers = new Headers({ location: "/?notice=goodbye" });
        for (const cookie of clearCookies) headers.append("set-cookie", cookie);
        return new Response(null, { status: 303, headers });
      },
    },
  },
});
