import { createFileRoute } from "@tanstack/react-router";

import { createOAuthClient } from "~/lib/oauth";

// Served at the client_id URL — authorization servers fetch this during PAR.
// Serve the library's metadata object verbatim so it always matches what the
// client actually sends.
export const Route = createFileRoute("/oauth/client-metadata.json")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const client = createOAuthClient(new URL(request.url).origin);
        return Response.json(client.metadata);
      },
    },
  },
});
