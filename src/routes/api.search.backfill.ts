/**
 * Search backfill: puts a writer's existing posts into the search index, one
 * page per call (~/lib/search's backfillStep). The dashboard calls it in a
 * loop until it answers `done`, once per writer, and new posts are indexed as
 * they are published, so after that this only ever answers `done`.
 *
 * The SESSION's DID is the only repo it reads, and it reads it over public
 * XRPC, so nothing here writes to a PDS. Per call: one DID-document fetch, one
 * listRecords page of BACKFILL_PAGE_SIZE records, one D1 batch.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import {
  isDid,
  listRecordsPage,
  NotFoundError,
  resolveDidToPds,
  type StandardDocument,
} from "~/lib/atproto";
import { readLiveSessionDid } from "~/lib/live-session";
import { isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import { BACKFILL_PAGE_SIZE, backfillStep } from "~/lib/search";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/search/backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return privateJson({ ok: false, error: "cross_site" }, 403);
        const db = drizzle(env.DB);
        const did = await readLiveSessionDid(request, env.COOKIE_SECRET, db);
        if (!did || !isDid(did))
          return privateJson({ ok: false, error: "not_signed_in" }, 401);

        try {
          const step = await backfillStep(db, did, async (cursor) => {
            const pds = await resolveDidToPds(did);
            return listRecordsPage<StandardDocument>(
              pds,
              did,
              "site.standard.document",
              { cursor, limit: BACKFILL_PAGE_SIZE },
            ).catch((err: unknown) => {
              // A repo the PDS won't list at all has nothing to index, which
              // is an end, not a failure to retry forever. Halfway through
              // the walk the same refusal is a failure: calling it the end
              // would mark a partial index complete.
              if (err instanceof NotFoundError && cursor === undefined)
                return { records: [], cursor: null };
              throw err;
            });
          });
          return privateJson({ ok: true, ...step });
        } catch (err) {
          console.warn("search backfill step failed", err);
          return privateJson({ ok: false, error: "unavailable" }, 502);
        }
      },
    },
  },
});
