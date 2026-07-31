/**
 * Is the reader looking at this page subscribed to this publication?
 *
 * WHY THIS IS AN ENDPOINT AND NOT PART OF THE READER LOADER. The reading
 * surfaces are edge-cached for 60 s and the cache key ignores cookies on
 * purpose — keying anonymity to the cookie would let an attacker dodge the
 * cache and force full-cost renders (see ~/lib/read-cache). So a subscribe
 * state answered inside `/@handle`'s HTML would be one reader's relationship,
 * cached and then served to everyone. The pages stay impersonal; this endpoint
 * answers the one personal question, privately, and the control asks it after
 * mount.
 *
 * Read-only, so no Origin check: a cross-site fetch cannot read this body
 * (CORS), and the write path — the single `/api/publish` handler — carries the
 * CSRF gate for both reader intents.
 *
 * Being signed out is a 200 with `signedIn: false`, not a 401: "are you
 * subscribed" has an honest answer for an anonymous reader, and the control
 * turns it into a sign-in path rather than into an error.
 *
 * WHAT IT DELIBERATELY DOES NOT ANSWER: how many people subscribe. Finding
 * every repo holding a subscription that points at a publication is a reverse
 * lookup the protocol does not offer (see ~/lib/subscription), so there is no
 * count to return and none is invented.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import {
  isDid,
  listRecordPages,
  resolveDidToPds,
  rkeyFromUri,
} from "~/lib/atproto";
import { readLiveSessionDid } from "~/lib/live-session";
import { privateJson } from "~/lib/private-json";
import {
  findSubscription,
  isAtUri,
  SUBSCRIPTION_COLLECTION,
} from "~/lib/subscription";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/subscription")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        // Untrusted, exactly as on the write path, and guarded by the same
        // lexicon-aware check.
        const publication = url.searchParams.get("publication");
        if (!isAtUri(publication))
          return privateJson({ ok: false, error: "invalid_publication" }, 400);

        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did))
          return privateJson({ ok: true, signedIn: false });

        const pds = await resolveDidToPds(did).catch(() => null);
        if (!pds) return privateJson({ ok: false, error: "unavailable" }, 502);

        // A failed read is NOT "not subscribed" — those are opposite claims,
        // and the wrong one puts a "Subscribe" button in front of a reader who
        // already did. `ok: false` renders as nothing at all instead.
        let subscription: string | null;
        try {
          const { records } = await listRecordPages<unknown>(
            pds,
            did,
            SUBSCRIPTION_COLLECTION,
          );
          subscription = findSubscription(records, publication, rkeyFromUri);
        } catch (err) {
          console.warn("subscription state read failed", err);
          return privateJson({ ok: false, error: "unavailable" }, 502);
        }

        // The rkey stays here: unsubscribing looks it up server-side, so the
        // page never needs to hold a record key to act on.
        return privateJson({
          ok: true,
          signedIn: true,
          subscribed: subscription !== null,
        });
      },
    },
  },
});
