/**
 * Import intake — the LAST step of every import, whichever door it came in
 * through: the browser has converted one picked item into BlockNote blocks
 * (feed/export HTML via /api/import, or a thread's markdown via
 * /api/threads/assemble), and this handler lands it as a draft AND writes the
 * import-ledger row in one atomic D1 batch, so a draft can never exist without
 * its provenance (or vice versa).
 *
 * One intake for both importers on purpose: dedupe, discarded-draft revival,
 * the draft cap and the atomic pair are the same rules regardless of where the
 * words came from, and the only thing that actually differs — how the published
 * page states its origin — is one recorded field (`source.kind`) rather than a
 * second copy of this handler.
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

import { isDid, parseAtUri } from "~/lib/atproto";
import { isBlobObject, readBodyCapped } from "~/lib/blob";
import { countDrafts, insertDraft } from "~/lib/drafts";
import { MAX_DRAFT_BODY_BYTES, MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import { bskyPostUrl } from "~/lib/engagement";
import {
  clampOriginalDate,
  guidHash,
  MAX_IMPORT_URL_LENGTH,
} from "~/lib/import";
import {
  insertImportItem,
  reviveImportItem,
  selectImportItem,
  selectLiveDraftIds,
} from "~/lib/import-store";
import { readLiveSessionDid } from "~/lib/live-session";
import { isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import { MAX_INLINE_IMAGES, MAX_TITLE_LENGTH } from "~/lib/publish";
import { env } from "cloudflare:workers";

const importDraftPayload = z.object({
  title: z.string().max(MAX_TITLE_LENGTH),
  /** BlockNote blocks — opaque array, same contract as /api/drafts. */
  content: z.array(z.unknown()),
  /** Blob refs for images already in the writer's repo (a thread's pictures),
   * stored as the draft's `inline_images` so publishing references them
   * instead of copying. Untrusted like the editor's own copy: only
   * well-formed blobs are kept, and publishing keeps only those the body
   * still uses. */
  inlineImages: z.array(z.unknown()).max(MAX_INLINE_IMAGES).default([]),
  source: z.object({
    /** The item's identity — a feed guid, or a thread's root at:// URI.
     * Hashed server-side for the ledger key. */
    guid: z.string().min(1).max(MAX_IMPORT_URL_LENGTH),
    /** The item's public URL — https only (it is stored and later rendered
     * as a provenance href; javascript:/data:/http: all refused here). */
    link: z
      .url({ protocol: /^https$/ })
      .max(MAX_IMPORT_URL_LENGTH)
      .nullish(),
    publishedAt: z.iso.datetime({ offset: true }).nullish(),
    /**
     * Which import this came from — a CLAIM, checked against the guid below
     * rather than believed (see `derivedKind`). Recorded on the ledger row
     * because it decides how the published page states its origin (`source_kind`
     * in ~/db/schema). Defaults to `feed` so a client that predates thread
     * import — a tab left open across a deploy — keeps making valid requests;
     * such a client never sends an at:// guid, so the default and the derivation
     * agree.
     */
    kind: z.enum(["feed", "thread"]).default("feed"),
  }),
});

/**
 * What this item ACTUALLY is, decided from the guid and the session — never
 * from the `kind` the client sent.
 *
 * `source_kind` is not bookkeeping: it decides what a published page says about
 * where the words came from ("originally posted on Bluesky" versus a link to
 * somebody else's publication), and that sentence is permanent and public. A
 * client-supplied enum meant anyone with a session could mint a thread-labelled
 * provenance for arbitrary text — or, in the other direction, launder a real
 * thread as a generic feed import.
 *
 * A thread is exactly one thing: an `app.bsky.feed.post` in the SESSION'S OWN
 * repo. The repo check is the half that matters — without it, a writer could
 * claim someone else's thread as self-imported, which is the provenance line
 * asserting a relationship that does not exist. Everything else is a feed.
 */
function derivedKind(guid: string, did: string): "feed" | "thread" {
  const uri = parseAtUri(guid);
  if (!uri) return "feed";
  return uri.collection === "app.bsky.feed.post" && uri.did === did
    ? "thread"
    : "feed";
}

export const Route = createFileRoute("/api/import/draft")({
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

        // Byte cap FIRST — the same bound stored drafts live under.
        const raw = await readBodyCapped(request, MAX_DRAFT_BODY_BYTES);
        if (raw === null)
          return privateJson({ ok: false, error: "too_large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return privateJson({ ok: false, error: "invalid" }, 400);
        }
        const parsed = importDraftPayload.safeParse(body);
        if (!parsed.success)
          return privateJson({ ok: false, error: "invalid" }, 400);
        const { title, content, inlineImages, source } = parsed.data;
        const blobs = inlineImages.filter(isBlobObject);

        // The kind comes from the evidence, not the claim. A "thread" claim
        // the guid doesn't back is refused. A "feed" item whose guid is the
        // writer's own post (their Bluesky RSS feed) IS a self-import, and
        // is filed as one.
        const kind = derivedKind(source.guid, did);
        if (source.kind === "thread" && kind !== "thread")
          return privateJson({ ok: false, error: "invalid" }, 400);

        // Re-serialize for storage (stored strings are always our own
        // stringify output); pathological nesting is a 400, not a crash.
        let contentJson: string;
        try {
          contentJson = JSON.stringify(content);
        } catch {
          return privateJson({ ok: false, error: "invalid" }, 400);
        }

        // Provenance link: only a public https URL is stored (it renders as
        // an href on reader pages). z.url() above already rejects javascript:
        // and friends; http links from old feeds are dropped, not upgraded.
        // A self-import's link is built from the guid, so the "thread on
        // Bluesky" line can only ever point at the writer's own post.
        const ownPost = kind === "thread" ? parseAtUri(source.guid) : null;
        const sourceUrl = ownPost
          ? bskyPostUrl(did, ownPost.rkey)
          : source.link?.startsWith("https://")
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
            return privateJson({ ok: false, error: "already_imported" }, 409);
          }
          const live = existing.draftId
            ? await selectLiveDraftIds(db, did, [existing.draftId])
            : [];
          if (live.length > 0) {
            return privateJson(
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
          return privateJson({ ok: false, error: "draft_limit" }, 409);
        }

        const draftId = crypto.randomUUID();
        const draftInsert = insertDraft(db, {
          id: draftId,
          did,
          title,
          // Imported items carry no subtitle of their own: the writer adds one
          // in the editor, or publishing generates the excerpt as before.
          dek: "",
          content: contentJson,
          inlineImages: blobs.length > 0 ? JSON.stringify(blobs) : "",
        });
        // One implicit transaction: the draft and its ledger row land (or
        // fail) together.
        await db.batch([
          draftInsert,
          revive
            ? reviveImportItem(db, did, hash, {
                draftId,
                sourceUrl,
                sourceKind: kind,
                originalAt,
              })
            : insertImportItem(db, {
                id: crypto.randomUUID(),
                did,
                guidHash: hash,
                sourceUrl,
                sourceKind: kind,
                originalAt,
                draftId,
              }),
        ]);
        return privateJson({ ok: true, draft: { id: draftId } }, 201);
      },
    },
  },
});
