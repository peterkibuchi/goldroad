/**
 * Feed-import API, step 2 of 2: the browser converted one picked item's HTML
 * to BlockNote blocks — this handler lands it as a draft AND writes the
 * import-ledger row in one atomic D1 batch, so a draft can never exist
 * without its provenance (or vice versa).
 *
 * Dedupe contract (idempotent re-runs):
 *  - ledger row published, or pointing at a still-live draft → 409
 *    `already_imported` (re-running an import skips what already came over);
 *  - ledger row whose unpublished draft was deleted → the row is re-pointed
 *    at the fresh draft (the writer discarded the copy; importing again is
 *    their honest path back).
 *
 * Same trust posture as /api/drafts: session → byte cap BEFORE parsing →
 * zod → every row op pairs ids with the session DID inside the SQL. The
 * draft-cap check is count-then-insert like /api/drafts — a guardrail, not
 * an exact quota.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { isDid } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { countDrafts, insertDraft } from "~/lib/drafts";
import { MAX_DRAFT_BODY_BYTES, MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import {
  clampOriginalDate,
  guidHash,
  isCrossSite,
  MAX_IMPORT_URL_LENGTH,
} from "~/lib/import";
import {
  insertImportItem,
  reviveImportItem,
  selectImportItem,
  selectLiveDraftIds,
} from "~/lib/import-store";
import { MAX_TITLE_LENGTH } from "~/lib/publish";
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

const importDraftPayload = z.object({
  title: z.string().max(MAX_TITLE_LENGTH),
  /** BlockNote blocks — opaque array, same contract as /api/drafts. */
  content: z.array(z.unknown()),
  source: z.object({
    /** The feed item's identity — hashed server-side for the ledger key. */
    guid: z.string().min(1).max(MAX_IMPORT_URL_LENGTH),
    /** The item's public URL — https only (it is stored and later rendered
     * as a provenance href; javascript:/data:/http: all refused here). */
    link: z
      .url({ protocol: /^https$/ })
      .max(MAX_IMPORT_URL_LENGTH)
      .nullish(),
    publishedAt: z.iso.datetime({ offset: true }).nullish(),
  }),
});

export const Route = createFileRoute("/api/import/draft")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return json({ ok: false, error: "cross_site" }, 403);
        const did = await readSessionDid(request, env.COOKIE_SECRET);
        if (!did || !isDid(did))
          return json({ ok: false, error: "not_signed_in" }, 401);

        // Byte cap FIRST — the same bound stored drafts live under.
        const raw = await readBodyCapped(request, MAX_DRAFT_BODY_BYTES);
        if (raw === null) return json({ ok: false, error: "too_large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }
        const parsed = importDraftPayload.safeParse(body);
        if (!parsed.success) return json({ ok: false, error: "invalid" }, 400);
        const { title, content, source } = parsed.data;

        // Re-serialize for storage (stored strings are always our own
        // stringify output); pathological nesting is a 400, not a crash.
        let contentJson: string;
        try {
          contentJson = JSON.stringify(content);
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }

        // Provenance link: only a public https URL is stored (it renders as
        // an href on reader pages). z.url() above already rejects javascript:
        // and friends; http links from old feeds are dropped, not upgraded.
        const sourceUrl = source.link?.startsWith("https://")
          ? source.link
          : null;
        const originalAt = clampOriginalDate(
          source.publishedAt ? new Date(source.publishedAt) : null,
        );

        const db = drizzle(env.DB);
        const hash = await guidHash(source.guid);
        const [existing] = await selectImportItem(db, did, hash);
        let revive = false;
        if (existing) {
          if (existing.publishedRkey) {
            return json({ ok: false, error: "already_imported" }, 409);
          }
          const live = existing.draftId
            ? await selectLiveDraftIds(db, did, [existing.draftId])
            : [];
          if (live.length > 0) {
            return json(
              {
                ok: false,
                error: "already_imported",
                draftId: existing.draftId,
              },
              409,
            );
          }
          revive = true; // imported before, draft since discarded — re-point
        }

        const [{ n }] = await countDrafts(db, did);
        if (n >= MAX_DRAFTS_PER_USER) {
          return json({ ok: false, error: "draft_limit" }, 409);
        }

        const draftId = crypto.randomUUID();
        const draftInsert = insertDraft(db, {
          id: draftId,
          did,
          title,
          content: contentJson,
        });
        // One implicit transaction: the draft and its ledger row land (or
        // fail) together.
        await db.batch([
          draftInsert,
          revive
            ? reviveImportItem(db, did, hash, {
                draftId,
                sourceUrl,
                originalAt,
              })
            : insertImportItem(db, {
                id: crypto.randomUUID(),
                did,
                guidHash: hash,
                sourceUrl,
                originalAt,
                draftId,
              }),
        ]);
        return json({ ok: true, draft: { id: draftId } }, 201);
      },
    },
  },
});
