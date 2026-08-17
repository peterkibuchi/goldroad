import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { readBodyCapped } from "~/lib/blob";
import { identFromFields, readerEmailPayload } from "~/lib/reader-email-schema";
import { insertReaderEmail } from "~/lib/reader-emails";
import { checkTurnstile, tokenFromBody } from "~/lib/turnstile";
import { env } from "cloudflare:workers";

/** Hard cap on the request body — an address, a DID, a surface name and a
 * Turnstile token are tiny. Matches the cap /api/waitlist gives an equally
 * small payload. */
const MAX_SUBSCRIBE_BYTES = 8 * 1024;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Where a no-JS submit lands. `to` is the publication identifier, so the page
 * can name the writer and link back; `failed` marks the answer that saved
 * nothing. The address itself is never in the URL — a query string ends up in
 * browser history, referrer headers and server logs.
 *
 * `failed=true` rather than `failed=1`: the router parses search values before
 * /subscribed sees them, so `1` arrives as a number and a flag spelled that way
 * reads as absent — which rendered a refusal as a confirmation. */
function seeOther(ident: string | undefined, failed = false): Response {
  const params = new URLSearchParams();
  if (ident) params.set("to", ident);
  if (failed) params.set("failed", "true");
  const query = params.size > 0 ? `?${params}` : "";
  return new Response(null, {
    status: 303,
    headers: { location: `/subscribed${query}` },
  });
}

/**
 * The submitted fields, whichever way they arrived. Both shapes are flat
 * string maps by the time zod sees them, so the schema stays single.
 *
 * Parse failures return null rather than throwing: a malformed body is the same
 * refusal as a malformed field.
 */
function decodeFields(contentType: string, bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  if (contentType.includes(FORM_CONTENT_TYPE)) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Reader email capture: a reader leaves an address with a publication.
 *
 * NOT to be confused with /api/subscription (GET) or /api/publish's subscribe
 * action, which are the atproto relationship — a record in the READER'S own
 * repo, pointing at the publication. This is the email one, and it lands in our
 * D1 because there is nowhere else for a mailing list to live yet. Sending is
 * not built; the surface says so in words rather than promising a date.
 *
 * ANTI-ABUSE IS /api/waitlist'S POSTURE, COPIED DELIBERATELY. This is the second
 * write endpoint an anonymous visitor is meant to reach, so it gets the same four
 * layers in the same order: a hard body cap read by streaming (before anything is
 * buffered or parsed), a honeypot field, schema validation, and a Turnstile check
 * when TURNSTILE_SECRET is set — with every failure answering ONE
 * indistinguishable response, so a bot learns nothing about which tripwire caught
 * it. Request rate is bounded at the edge by the WAF rule over /api/*, which is
 * the right layer for it: refusing a flood inside the Worker means having already
 * paid for the Worker.
 *
 * IT ANSWERS IN TWO LANGUAGES, and the request says which. A submit with
 * JavaScript posts JSON and gets the same `{ ok }` envelope every other endpoint
 * here returns, because the form renders its own outcome in place. A submit
 * WITHOUT JavaScript is a plain browser form POST (`application/x-www-form-
 * urlencoded`) whose response becomes the reader's next page, so it gets a 303 to
 * /subscribed instead — a JSON body would be a dead end, and the reading page it
 * came from cannot render the outcome itself (those pages are edge-cached on a
 * key that ignores query strings, so a `?saved=1` would either miss the state or
 * cache one reader's confirmation for everybody).
 *
 * The one honest limit on the no-JS path: the Turnstile widget needs JavaScript
 * to produce a token, so when the secret IS configured a no-JS submit cannot
 * pass — it lands on the same "nothing was saved" page, whose copy names both
 * causes. That trade belongs to Turnstile rather than to this endpoint, and the
 * alternative (exempting form-encoded posts from the check) would be a hole with
 * a sign on it.
 */
export const Route = createFileRoute("/api/subscribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("content-type") ?? "";
        const isForm = contentType.includes(FORM_CONTENT_TYPE);
        // ONE refusal for every tripwire below, in whichever language the
        // request spoke. A no-JS refusal has to be a page rather than a status
        // code: the browser is going to render whatever comes back.
        const bad = (ident?: string) =>
          isForm
            ? seeOther(ident, true)
            : Response.json({ ok: false, error: "invalid" }, { status: 400 });

        // Bounded before it is buffered: an address, a DID and a token need
        // very little room, and nothing else stands between the open internet
        // and this read (the Turnstile check happens after the parse).
        const bytes = await readBodyCapped(request, MAX_SUBSCRIBE_BYTES);
        if (!bytes) return bad();
        const fields = decodeFields(contentType, bytes);
        if (fields === null) return bad();
        // Vetted before validation, so every refusal below can still hand a
        // no-JS reader the way back to the page they were reading — a refusal
        // they can't leave is how the /login POST used to strand people.
        const ident = identFromFields(fields);

        const parsed = readerEmailPayload.safeParse(fields);
        if (!parsed.success) return bad(ident);

        const human = await checkTurnstile(
          env.TURNSTILE_SECRET,
          tokenFromBody(fields),
          request.headers.get("cf-connecting-ip"),
        );
        if (!human) return bad(ident);

        const { email, writerDid, source } = parsed.data;
        const db = drizzle(env.DB);
        // Idempotent: an address this writer already holds answers exactly as
        // an address they don't, so the endpoint is not an oracle for whether
        // someone reads a given publication (see ~/lib/reader-emails).
        await insertReaderEmail(db, { email, writerDid, source });
        return isForm ? seeOther(ident) : Response.json({ ok: true });
      },
    },
  },
});
