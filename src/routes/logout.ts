import { createFileRoute } from "@tanstack/react-router";

import { isDid } from "~/lib/atproto";
import { createOAuthClient } from "~/lib/oauth";
import { isCrossSite } from "~/lib/origin";
import { readSessionDid, sessionClearCookie } from "~/lib/session";
import { env } from "cloudflare:workers";

/**
 * Sign-out: revoke upstream, drop the D1 session, clear the cookie.
 *
 * CSRF: forced sign-out is a nuisance, not a breach, but it is still a state
 * change an attacker's page shouldn't be able to trigger — so the same
 * one-header check every other mutating handler runs (isCrossSite,
 * ~/lib/origin) gates it. A cross-site POST gets the SAME 302 to "/" as a
 * real sign-out, minus the revoke and minus the cookie clear: from the
 * user's side the request is inert (they stay signed in, nothing 403s in
 * their face), and from the attacker's side the response is indistinguishable
 * from success while no session was actually ended.
 */
export const Route = createFileRoute("/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const home = (extra?: HeadersInit) =>
          new Response(null, {
            status: 302,
            headers: { location: "/", ...extra },
          });
        if (isCrossSite(request)) return home();

        // Deliberately the signature-only read, not the liveness one: signing
        // out must work even when the session row is already gone. Requiring a
        // live row here would make a half-revoked session impossible to clear,
        // which is the opposite of what someone clicking "sign out" wants. This
        // handler only revokes upstream and clears a cookie — there is nothing
        // to protect behind a liveness check.
        const did = await readSessionDid(request, env.COOKIE_SECRET);
        if (did && isDid(did)) {
          // Best-effort: revoke tokens upstream and drop the D1 session.
          // A failed revoke must never block clearing the cookie.
          try {
            await createOAuthClient(url.origin).revoke(did);
          } catch (err) {
            console.warn("token revoke failed", err);
          }
        }
        return home({
          "set-cookie": sessionClearCookie(url.protocol === "https:"),
        });
      },
    },
  },
});
