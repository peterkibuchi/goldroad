import { z } from "zod";

import { isDid, isHandle } from "~/lib/atproto";

/**
 * Reader email-capture payload — shared by /api/subscribe, the capture form and
 * their tests. Pure (no Workers bindings), so the browser and the tests can both
 * import it.
 *
 * `email` is trimmed and LOWERCASED here rather than in the handler, because
 * this is the door: the unique key in `reader_emails` is (writer_did, email),
 * and a key that only dedupes exact-case addresses is not a duplicate check at
 * all. 254 is the RFC 5321 address ceiling, the same bound the waitlist uses.
 *
 * `writerDid` arrives FROM THE CLIENT, and that is a considered trade. The
 * alternative is resolving the page's handle server-side on every submit, which
 * hangs an upstream identity lookup off an unauthenticated endpoint — an
 * amplifier pointed at other people's infrastructure, which is a worse problem
 * than the one it solves. So the shape is validated (a DID and nothing else) and
 * the value is trusted exactly as far as `email` is: what a hostile client can
 * do here is write junk rows, which is what the body cap, the honeypot, the
 * Turnstile gate and the edge rate limit on /api/* are for.
 *
 * The form also carries an `ident` (the page's handle) and, when configured, a
 * Turnstile token. Neither is described here and neither is stored: unknown keys
 * are stripped, the token is anti-bot plumbing that stays out of the data
 * contract (~/lib/turnstile), and `ident` only decorates the no-JS
 * confirmation — so it is vetted at the one place that turns it into a URL.
 *
 * `gr_extra` is the same honeypot the waitlist and report forms use, with the
 * same deliberately opaque name — Chrome autofills recognizable names like
 * "company" even when the field is hidden (crbug 40223868), which would reject
 * real readers.
 */
export const readerEmailPayload = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  writerDid: z.string().refine(isDid, "not a DID"),
  /** Which reading surface the reader was on — see `reader_emails.source`. */
  source: z.enum(["post", "publication"]),
  gr_extra: z.literal("").optional(),
});

/**
 * The publication identifier a submit came from, if it is one.
 *
 * Read off the RAW fields rather than through the schema above, because it is
 * needed on the paths where that parse failed: a no-JS refusal still has to hand
 * the reader a way back to the page they were on, the same way the /login POST
 * echoes a mistyped handle back to the form it came from. A form field that
 * becomes part of a Location is how open redirects happen, so this is the one
 * gate it passes: a handle or a DID, from which we construct a path ourselves.
 */
export function identFromFields(fields: unknown): string | undefined {
  if (typeof fields !== "object" || fields === null) return undefined;
  const value = (fields as Record<string, unknown>).ident;
  if (typeof value !== "string") return undefined;
  return isHandle(value) || isDid(value) ? value : undefined;
}

export type ReaderEmailPayload = z.infer<typeof readerEmailPayload>;
