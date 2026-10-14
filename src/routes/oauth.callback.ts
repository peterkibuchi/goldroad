import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { readSessionRowSid } from "~/lib/live-session";
import { createOAuthClient, safeReturnTo } from "~/lib/oauth";
import {
  OAUTH_STATE_COOKIE,
  oauthStateClearCookie,
  readCookie,
  sessionHintSetCookie,
  sessionSetCookie,
  signSession,
} from "~/lib/session";
import { env } from "cloudflare:workers";

/**
 * OAuth callback: exchanges the authorization code (DPoP-bound token request),
 * stores the session in D1, and sets the signed session cookie. The cookie
 * carries the DID and the session row's id — tokens never leave the server.
 *
 * The state must be the one this browser's /login set in its cookie. Without
 * that check, someone could start a sign-in to their own account, stop before
 * the redirect, and send the callback link to someone else, whose browser
 * would then be signed in as them. It's checked before the code exchange, so a
 * refused callback consumes nothing.
 */
export const Route = createFileRoute("/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const secure = url.protocol === "https:";
        const failed = () => {
          const headers = new Headers({
            location: "/write?error=signin_failed",
          });
          headers.append("set-cookie", oauthStateClearCookie(secure));
          return new Response(null, { status: 302, headers });
        };

        const expected = readCookie(request, OAUTH_STATE_COOKIE);
        const state = url.searchParams.get("state");
        if (!expected || !state || expected !== state) {
          console.warn("oauth callback state does not match this browser");
          return failed();
        }

        const client = createOAuthClient(url.origin, { signIn: true });
        try {
          const { session, state: appState } = await client.callback(
            url.searchParams,
          );
          const sid = await readSessionRowSid(drizzle(env.DB), session.did);
          if (!sid) throw new Error("session row has no sid after sign-in");
          const token = await signSession(session.did, sid, env.COOKIE_SECRET);
          const returnTo = safeReturnTo(
            (appState as { returnTo?: unknown } | undefined)?.returnTo,
          );
          // The real session (HttpOnly, the only thing trusted) and a readable
          // presence flag carrying no identity, so cached marketing HTML can
          // correct its own "Sign in" label client-side.
          const headers = new Headers({ location: returnTo });
          headers.append("set-cookie", sessionSetCookie(token, secure));
          headers.append("set-cookie", sessionHintSetCookie(secure));
          headers.append("set-cookie", oauthStateClearCookie(secure));
          return new Response(null, { status: 302, headers });
        } catch (err) {
          console.error("oauth callback failed", err);
          return failed();
        }
      },
    },
  },
});
