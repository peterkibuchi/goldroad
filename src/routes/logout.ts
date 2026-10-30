import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { isDid } from "~/lib/atproto";
import { readSessionToEnd } from "~/lib/live-session";
import { createOAuthClient } from "~/lib/oauth";
import { isCrossSite } from "~/lib/origin";
import { deleteOAuthSessionForDid } from "~/lib/rights-store";
import { clearSessionCookies } from "~/lib/session";
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

        // The cookies are cleared whatever happens. The session itself is
        // only ended when this cookie names it: a stale cookie from an
        // earlier session must not be able to sign out the current one.
        const db = drizzle(env.DB);
        const did = await readSessionToEnd(
          request,
          env.COOKIE_SECRET,
          db,
        ).catch((err) => {
          console.error("session read failed during sign-out", err);
          return null;
        });
        if (did && isDid(did)) {
          // Best-effort upstream revoke, then the row itself: revoke() can
          // throw before it reaches its own delete, and the row is what
          // keeps this cookie valid.
          try {
            await createOAuthClient(url.origin).revoke(did);
          } catch (err) {
            console.warn("token revoke failed", err);
          }
          try {
            await deleteOAuthSessionForDid(db, did);
          } catch (err) {
            console.error("session row delete failed", err);
          }
        }
        const headers = new Headers({ location: "/" });
        for (const cookie of clearSessionCookies(url.protocol === "https:"))
          headers.append("set-cookie", cookie);
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
