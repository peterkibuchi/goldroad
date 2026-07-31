import { createFileRoute } from "@tanstack/react-router";

import { createOAuthClient, safeReturnTo } from "~/lib/oauth";
import {
  sessionHintSetCookie,
  sessionSetCookie,
  signSession,
} from "~/lib/session";
import { env } from "cloudflare:workers";

/**
 * OAuth callback: exchanges the authorization code (DPoP-bound token request),
 * stores the session in D1, and sets the signed session cookie. The cookie
 * carries only the DID — tokens never leave the server.
 */
export const Route = createFileRoute("/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const client = createOAuthClient(url.origin);
        try {
          const { session, state } = await client.callback(url.searchParams);
          const token = await signSession(session.did, env.COOKIE_SECRET);
          const returnTo = safeReturnTo(
            (state as { returnTo?: unknown } | undefined)?.returnTo,
          );
          // Two cookies: the real session (HttpOnly, the only thing trusted)
          // and a readable presence flag carrying no identity, so cached
          // marketing HTML can correct its own "Sign in" label client-side
          // without the response having to vary per visitor.
          const secure = url.protocol === "https:";
          const headers = new Headers({ location: returnTo });
          headers.append("set-cookie", sessionSetCookie(token, secure));
          headers.append("set-cookie", sessionHintSetCookie(secure));
          return new Response(null, { status: 302, headers });
        } catch (err) {
          console.error("oauth callback failed", err);
          return new Response(null, {
            status: 302,
            headers: { location: "/write?error=signin_failed" },
          });
        }
      },
    },
  },
});
