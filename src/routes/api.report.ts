import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { reports } from "~/db/schema";
import { readBodyCapped } from "~/lib/blob";
import { reportPayload } from "~/lib/report-schema";
import { checkTurnstile, tokenFromBody } from "~/lib/turnstile";
import { env } from "cloudflare:workers";

/** Hard cap on the request body — a report is small (url + a short note).
 * Bounds an unauthenticated write before we buffer/parse it. */
const MAX_REPORT_BYTES = 16_384;

const bad = () =>
  Response.json({ ok: false, error: "invalid" }, { status: 400 });

/**
 * Abuse-report intake (moderation kit, audit #1). Same posture as
 * /api/waitlist: JSON-only, zod-validated, honeypot-gated, one D1 insert — plus
 * a hard body cap (streamed via readBodyCapped, like /img). A human triages
 * `reports` against the hidden_content list.
 *
 * Anti-abuse: body cap + honeypot always; a Turnstile check additionally
 * gates the insert when the TURNSTILE_SECRET Worker secret is set (see
 * ~/lib/turnstile — absent secret means passthrough, i.e. the pre-Turnstile
 * behavior). REMAINING OWNER ACTION: this endpoint still has no server-side
 * rate limit — add the single free CF rate-limit rule on this path.
 */
export const Route = createFileRoute("/api/report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const bytes = await readBodyCapped(request, MAX_REPORT_BYTES);
        if (!bytes) return bad();
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return bad();
        }
        const parsed = reportPayload.safeParse(body);
        if (!parsed.success) return bad();

        // Turnstile, env-gated: no secret → passthrough; secret set → a
        // verified token must gate the write. Failure answers the same
        // indistinguishable 400 as the schema/honeypot path.
        const human = await checkTurnstile(
          env.TURNSTILE_SECRET,
          tokenFromBody(body),
          request.headers.get("cf-connecting-ip"),
        );
        if (!human) return bad();

        const { url, reason } = parsed.data;
        const email = parsed.data.email ? parsed.data.email : null;
        const db = drizzle(env.DB);
        await db.insert(reports).values({ url, reason, email });
        return Response.json({ ok: true });
      },
    },
  },
});
