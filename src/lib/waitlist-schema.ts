import { z } from "zod";

/** Shared by the API handler and unit tests. `gr_extra` is a honeypot:
 * humans never see the field, so any non-empty value means a bot. The name is
 * deliberately opaque — Chrome autofills recognizable names like "company"
 * even when the field is hidden (crbug 40223868), rejecting real signups. */
export const waitlistPayload = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  gr_extra: z.literal("").optional(),
});

export type WaitlistPayload = z.infer<typeof waitlistPayload>;
