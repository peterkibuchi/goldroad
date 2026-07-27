import { createFileRoute } from "@tanstack/react-router";

import { isDid } from "~/lib/atproto";
import { createOAuthClient } from "~/lib/oauth";
import { readSessionDid, sessionClearCookie } from "~/lib/session";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
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
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": sessionClearCookie(url.protocol === "https:"),
          },
        });
      },
    },
  },
});
