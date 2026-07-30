import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { waitlist } from "~/db/schema";
import { readBodyCapped } from "~/lib/blob";
import { checkTurnstile, tokenFromBody } from "~/lib/turnstile";
import { waitlistPayload } from "~/lib/waitlist-schema";
import { env } from "cloudflare:workers";

/** Hard cap on the request body — an email plus a Turnstile token is tiny.
 * Matches the treatment /api/report already gives an equally small payload. */
const MAX_WAITLIST_BYTES = 8 * 1024;

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const bad = () =>
          Response.json({ ok: false, error: "invalid" }, { status: 400 });
        // Bound the body before buffering it. This is the one write endpoint an
        // anonymous visitor is *meant* to reach, and Turnstile is checked below
        // — after the parse — so nothing else stands between the internet and
        // an unbounded read. An email and a token need very little room.
        const bytes = await readBodyCapped(request, MAX_WAITLIST_BYTES);
        if (!bytes) return bad();
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return bad();
        }
        const parsed = waitlistPayload.safeParse(body);
        if (!parsed.success) return bad();

        // Turnstile, env-gated: no TURNSTILE_SECRET → passthrough (exactly
        // the pre-Turnstile behavior); secret set → the request must carry a
        // verified widget token. Failure answers the SAME 400 as the schema/
        // honeypot path, so a bot can't tell which tripwire caught it.
        const human = await checkTurnstile(
          env.TURNSTILE_SECRET,
          tokenFromBody(body),
          request.headers.get("cf-connecting-ip"),
        );
        if (!human) return bad();

        const email = parsed.data.email;
        const db = drizzle(env.DB);
        // Idempotent: duplicate signups succeed silently (no email enumeration).
        await db.insert(waitlist).values({ email }).onConflictDoNothing();
        return Response.json({ ok: true });
      },
    },
  },
});
