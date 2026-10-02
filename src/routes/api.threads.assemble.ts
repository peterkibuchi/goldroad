/**
 * Thread-import API, step 2 of 3: turn ONE of the writer's threads into
 * markdown.
 *
 * Why the conversion is here and not in the browser (the mirror image of
 * /api/import, where the browser converts): the interesting work is reading
 * untrusted AppView JSON — byte-capped, timeout-bounded, facet ranges applied
 * in byte space, embeds discriminated by shape — and that belongs where it can
 * be unit-tested against fixtures without a DOM (~/lib/threads). The browser's
 * remaining job is markdown → editor blocks, which is one BlockNote call.
 *
 * The writer's own DID is taken from the SESSION and passed as the expected
 * author, so a root URI naming somebody else's post assembles to nothing. That
 * is deliberate and not merely a filter: this endpoint exists to move a
 * writer's own words, and it must not become a way to launder a stranger's
 * thread into a Goldroad record.
 *
 * Atomic per item, which is HARD RULE for this feature: assembly either
 * produces a whole thread or an error, and the draft is written by a separate
 * call afterwards. A thread that fails mid-assembly therefore lands nothing —
 * there is no partial draft to find later and no half-imported row in the
 * ledger.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { isDid, parseAtUri } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import {
  countRecentImportFetches,
  insertImportFetch,
  pruneImportFetches,
} from "~/lib/import-store";
import { readLiveSessionDid } from "~/lib/live-session";
import { isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import { MAX_BODY_LENGTH } from "~/lib/publish";
import {
  assembleThread,
  fetchThread,
  MAX_THREAD_FETCHES_PER_HOUR,
} from "~/lib/threads";
import { env } from "cloudflare:workers";

/** Matches /api/import's and /api/threads' window. */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** at:// URIs are short; this is a sanity bound before parseAtUri sees it. */
const MAX_AT_URI_LENGTH = 512;

const assemblePayload = z.object({
  rootUri: z.string().min(1).max(MAX_AT_URI_LENGTH),
});

export const Route = createFileRoute("/api/threads/assemble")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return privateJson({ ok: false, error: "cross_site" }, 403);
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did))
          return privateJson({ ok: false, error: "not_signed_in" }, 401);

        // The payload is one short URI — cap the body well below any parse.
        const raw = await readBodyCapped(request, 8 * 1024);
        if (raw === null)
          return privateJson({ ok: false, error: "too_large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return privateJson({ ok: false, error: "invalid" }, 400);
        }
        const parsed = assemblePayload.safeParse(body);
        if (!parsed.success)
          return privateJson({ ok: false, error: "invalid" }, 400);

        // The URI must be a Bluesky post IN THE SESSION'S OWN REPO. Checked
        // here as well as inside assembleThread, so a request for somebody
        // else's thread is refused before it costs an upstream fetch.
        const parts = parseAtUri(parsed.data.rootUri);
        const ownPost =
          parts?.collection === "app.bsky.feed.post" && parts.did === did;
        if (!ownPost)
          return privateJson({ ok: false, error: "not_your_post" }, 403);

        const db = drizzle(env.DB);
        const windowStart = new Date(Date.now() - RATE_WINDOW_MS);
        await pruneImportFetches(db, windowStart);
        const [{ n }] = await countRecentImportFetches(
          db,
          did,
          windowStart,
          "thread",
        );
        if (n >= MAX_THREAD_FETCHES_PER_HOUR)
          return privateJson({ ok: false, error: "rate_limited" }, 429);
        await insertImportFetch(db, did, "thread");

        const upstream = await fetchThread(parsed.data.rootUri);
        if (upstream === null)
          return privateJson({ ok: false, error: "appview_failed" }, 502);

        const thread = assembleThread(upstream, {
          rootUri: parsed.data.rootUri,
          author: did,
        });
        // One refusal for every "there is no thread here" case: deleted,
        // blocked, a single post with no self-reply, or a chain that assembled
        // to nothing. The picker shows it as a row that didn't come across —
        // it needs to say so, not to tell them which of those it was.
        if (!thread)
          return privateJson({ ok: false, error: "not_a_thread" }, 422);
        // A thread longer than a document body can hold is refused rather than
        // silently cut: the writer keeps the original and can split it.
        if (thread.markdown.length > MAX_BODY_LENGTH)
          return privateJson({ ok: false, error: "too_long" }, 413);

        return privateJson({ ok: true, thread });
      },
    },
  },
});
