import { createFileRoute } from "@tanstack/react-router";

import { createOAuthClient, safeReturnTo } from "~/lib/oauth";
import { sessionSetCookie, signSession } from "~/lib/session";
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
          return new Response(null, {
            status: 302,
            headers: {
              location: returnTo,
              "set-cookie": sessionSetCookie(token, url.protocol === "https:"),
            },
          });
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
