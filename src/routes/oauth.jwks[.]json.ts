import { createFileRoute } from "@tanstack/react-router";

import { createOAuthClient } from "~/lib/oauth";

// Public JWKS for private_key_jwt client assertions. Public keys only —
// OAuthClient#jwks never exposes private material. Empty set for the dev
// loopback client (public clients have no keys).
export const Route = createFileRoute("/oauth/jwks.json")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const client = createOAuthClient(new URL(request.url).origin);
        return Response.json(client.jwks ?? { keys: [] });
      },
    },
  },
});
