import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { reports } from "~/db/schema";
import { readBodyCapped } from "~/lib/blob";
import { reportPayload } from "~/lib/report-schema";
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
 * ACCEPTED RISK until the owner lands anti-abuse: this endpoint is
 * unauthenticated and has NO server-side rate limit yet — the body cap and
 * honeypot are the only throttles. OWNER ACTIONS: verify a Turnstile token
 * before the insert (integration point below) and add the single free CF
 * rate-limit rule on this path. Don't assume a throttle exists until those land.
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

        // TURNSTILE INTEGRATION POINT (owner action): when TURNSTILE_SECRET is
        // wired, verify parsed.data's token against siteverify here and 400 on
        // failure — before the insert, so a solved challenge gates the write.

        const { url, reason } = parsed.data;
        const email = parsed.data.email ? parsed.data.email : null;
        const db = drizzle(env.DB);
        await db.insert(reports).values({ url, reason, email });
        return Response.json({ ok: true });
      },
    },
  },
});
