/**
 * Drafts API — create/update (upsert), list, get-one, delete.
 *
 * Drafts stay server-side, in our D1, keyed to the signed-in DID; only
 * publishing writes to the writer's atproto repo (an atproto record is public
 * the moment it exists, so a "private draft record" is a contradiction).
 *
 * Trust posture, in order:
 *  1. Session cookie → DID (same helper as /api/publish); no session, no API.
 *  2. Request body is byte-capped BEFORE any parsing (readBodyCapped — the
 *     same streaming cap the blob pipeline uses), so an oversized body costs
 *     a stream cancel, not a JSON.parse of unbounded input.
 *  3. Payload shape is zod-validated; block content stays an opaque array.
 *  4. Every row op pairs id with the session DID inside the SQL (~/lib/drafts)
 *     — "not yours" and "doesn't exist" are the same 404, so the API never
 *     confirms another writer's draft ids.
 *
 * A save carries TWO renderings of the same document — the block JSON
 * (lossless, what the editor reloads) and its markdown projection (lossy, what
 * publishing writes to the record and what a scheduled publish reads hours
 * later) — plus the blob references the projection's images need. All of it is
 * written in one statement so none of it can drift; see `markdown` and
 * `inline_images` in ~/db/schema for why they have to be stored at all.
 *
 * Every response is `cache-control: no-store`: drafts are private data and
 * must never sit in a shared or browser cache.
 *
 * Concurrency: updates are last-write-wins by design (no version
 * precondition) — the same model as most autosave systems; two tabs editing
 * one draft overwrite each other silently. Revisit if that bites real
 * writers. Operation frequency is bounded client-side (throttled autosave),
 * not here — a hostile client can spend D1 writes at line rate, which is a
 * platform rate-limit concern (one rule on /api/*), not a handler one.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { readBodyCapped } from "~/lib/blob";
import {
  countDrafts,
  deleteDraft,
  insertDraft,
  listDrafts,
  selectDraft,
  updateDraft,
} from "~/lib/drafts";
import {
  draftPayload,
  isDraftId,
  MAX_DRAFT_BODY_BYTES,
  MAX_DRAFTS_PER_USER,
} from "~/lib/drafts-schema";
import { readLiveSessionDid } from "~/lib/live-session";
import { isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import { deleteSchedulesForDraft } from "~/lib/scheduled-posts";
import { env } from "cloudflare:workers";

async function requireDid(request: Request): Promise<string | null> {
  return readLiveSessionDid(request, env.COOKIE_SECRET, drizzle(env.DB));
}

/** Stored content is server-serialized JSON (an array, written by POST), so a
 * parse failure here means a corrupt row — return null and let the editor
 * start empty rather than crash the resume. */
function parseStoredContent(content: string): unknown[] | null {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/drafts")({
  server: {
    handlers: {
      /** List my drafts (no `id`), or fetch one with content (`?id=`). */
      GET: async ({ request }) => {
        const did = await requireDid(request);
        if (!did)
          return privateJson({ ok: false, error: "not_signed_in" }, 401);
        const db = drizzle(env.DB);

        const id = new URL(request.url).searchParams.get("id");
        if (id !== null) {
          if (!isDraftId(id))
            return privateJson({ ok: false, error: "not_found" }, 404);
          const [row] = await selectDraft(db, did, id);
          if (!row) return privateJson({ ok: false, error: "not_found" }, 404);
          return privateJson({
            ok: true,
            draft: {
              id: row.id,
              title: row.title,
              dek: row.dek,
              content: parseStoredContent(row.content),
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
          });
        }

        const rows = await listDrafts(db, did);
        return privateJson({
          ok: true,
          drafts: rows.map((row) => ({
            id: row.id,
            title: row.title,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })),
        });
      },

      /** Upsert: `id` present = update my draft, absent = create (capped). */
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return privateJson({ ok: false, error: "cross_site" }, 403);
        const did = await requireDid(request);
        if (!did)
          return privateJson({ ok: false, error: "not_signed_in" }, 401);

        // Byte cap FIRST — never JSON.parse an unbounded body.
        const raw = await readBodyCapped(request, MAX_DRAFT_BODY_BYTES);
        if (raw === null)
          return privateJson({ ok: false, error: "too_large" }, 413);

        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return privateJson({ ok: false, error: "invalid" }, 400);
        }
        const parsed = draftPayload.safeParse(body);
        if (!parsed.success)
          return privateJson({ ok: false, error: "invalid" }, 400);

        // Re-serialize for storage so the stored string is always our own
        // JSON.stringify output. Guarded: pathological nesting can survive
        // parse yet overflow stringify — that is a 400, not a worker error.
        let content: string;
        try {
          content = JSON.stringify(parsed.data.content);
        } catch {
          return privateJson({ ok: false, error: "invalid" }, 400);
        }

        const db = drizzle(env.DB);
        if (parsed.data.id) {
          const [row] = await updateDraft(db, did, parsed.data.id, {
            title: parsed.data.title,
            dek: parsed.data.dek,
            content,
            // Absent = keep what's stored (see updateDraft): the projection is
            // what a scheduled publish reads, so no save may blank it by
            // omission.
            markdown: parsed.data.markdown,
            inlineImages: parsed.data.inlineImages,
          });
          if (!row) return privateJson({ ok: false, error: "not_found" }, 404);
          return privateJson({
            ok: true,
            draft: { id: row.id, updatedAt: row.updatedAt.toISOString() },
          });
        }

        // Count-then-insert (not atomic; two racing creates can land at
        // cap+1 — the cap is a guardrail against unbounded growth, not an
        // exact quota, so that slack is fine).
        const [{ n }] = await countDrafts(db, did);
        if (n >= MAX_DRAFTS_PER_USER) {
          return privateJson({ ok: false, error: "draft_limit" }, 409);
        }
        const [row] = await insertDraft(db, {
          id: crypto.randomUUID(),
          did,
          title: parsed.data.title,
          dek: parsed.data.dek,
          content,
          markdown: parsed.data.markdown,
          inlineImages: parsed.data.inlineImages,
        });
        return privateJson(
          {
            ok: true,
            draft: { id: row.id, updatedAt: row.updatedAt.toISOString() },
          },
          201,
        );
      },

      /** Delete my draft (`?id=`). */
      DELETE: async ({ request }) => {
        if (isCrossSite(request))
          return privateJson({ ok: false, error: "cross_site" }, 403);
        const did = await requireDid(request);
        if (!did)
          return privateJson({ ok: false, error: "not_signed_in" }, 401);
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!isDraftId(id))
          return privateJson({ ok: false, error: "not_found" }, 404);
        const db = drizzle(env.DB);
        const rows = await deleteDraft(db, did, id);
        if (rows.length === 0) {
          return privateJson({ ok: false, error: "not_found" }, 404);
        }
        // Deleting a draft IS cancelling its schedule: the row that survived
        // would be an instruction to publish something that no longer exists,
        // and it would fail loudly an hour later for something the writer did
        // on purpose. Best-effort — the draft is already gone, and the cron
        // fails a schedule whose draft is missing rather than publishing an
        // empty post.
        await deleteSchedulesForDraft(db, did, id).catch((err) => {
          console.warn("schedule cleanup after draft delete failed", err);
        });
        return privateJson({ ok: true });
      },
    },
  },
});
