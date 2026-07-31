import { z } from "zod";

/**
 * Abuse-report payload (moderation kit, audit #1). Shared by the API handler
 * and its tests. `gr_extra` is the same honeypot as the waitlist — an opaque
 * name so Chrome doesn't autofill it (crbug 40223868) and reject real reports.
 * `email` is optional (reporters may stay anonymous); `url` and `reason` are
 * bounded so a hostile client can't stuff the D1 row.
 */
export const reportPayload = z.object({
  url: z.string().trim().min(1).max(2048),
  reason: z.string().trim().min(1).max(2000),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254))
    .optional()
    .or(z.literal("")),
  gr_extra: z.literal("").optional(),
});
