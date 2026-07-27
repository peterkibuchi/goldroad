import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { waitlist } from "~/db/schema";
import { waitlistPayload } from "~/lib/waitlist-schema";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { ok: false, error: "invalid" },
            { status: 400 },
          );
        }
        const parsed = waitlistPayload.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { ok: false, error: "invalid" },
            { status: 400 },
          );
        }
        const email = parsed.data.email;
        const db = drizzle(env.DB);
        // Idempotent: duplicate signups succeed silently (no email enumeration).
        await db.insert(waitlist).values({ email }).onConflictDoNothing();
        return Response.json({ ok: true });
      },
    },
  },
});
