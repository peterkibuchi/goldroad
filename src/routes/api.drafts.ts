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

import { isDid } from "~/lib/atproto";
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
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function requireDid(request: Request): Promise<string | null> {
  const did = await readSessionDid(request, env.COOKIE_SECRET);
  return did && isDid(did) ? did : null;
}

/** CSRF defense-in-depth for the mutating methods: SameSite=Lax already
 * keeps the session cookie off cross-site POSTs, so this only matters for
 * legacy browsers — but it's one header comparison. Browsers send Origin on
 * all POST/DELETE (same-origin included); absent means a non-browser client,
 * which the cookie requirement already covers. */
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
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
        if (!did) return json({ ok: false, error: "not_signed_in" }, 401);
        const db = drizzle(env.DB);

        const id = new URL(request.url).searchParams.get("id");
        if (id !== null) {
          if (!isDraftId(id))
            return json({ ok: false, error: "not_found" }, 404);
          const [row] = await selectDraft(db, did, id);
          if (!row) return json({ ok: false, error: "not_found" }, 404);
          return json({
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
        return json({
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
          return json({ ok: false, error: "cross_site" }, 403);
        const did = await requireDid(request);
        if (!did) return json({ ok: false, error: "not_signed_in" }, 401);

        // Byte cap FIRST — never JSON.parse an unbounded body.
        const raw = await readBodyCapped(request, MAX_DRAFT_BODY_BYTES);
        if (raw === null) return json({ ok: false, error: "too_large" }, 413);

        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }
        const parsed = draftPayload.safeParse(body);
        if (!parsed.success) return json({ ok: false, error: "invalid" }, 400);

        // Re-serialize for storage so the stored string is always our own
        // JSON.stringify output. Guarded: pathological nesting can survive
        // parse yet overflow stringify — that is a 400, not a worker error.
        let content: string;
        try {
          content = JSON.stringify(parsed.data.content);
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }

        const db = drizzle(env.DB);
        if (parsed.data.id) {
          const [row] = await updateDraft(db, did, parsed.data.id, {
            title: parsed.data.title,
            dek: parsed.data.dek,
            content,
          });
          if (!row) return json({ ok: false, error: "not_found" }, 404);
          return json({
            ok: true,
            draft: { id: row.id, updatedAt: row.updatedAt.toISOString() },
          });
        }

        // Count-then-insert (not atomic; two racing creates can land at
        // cap+1 — the cap is a guardrail against unbounded growth, not an
        // exact quota, so that slack is fine).
        const [{ n }] = await countDrafts(db, did);
        if (n >= MAX_DRAFTS_PER_USER) {
          return json({ ok: false, error: "draft_limit" }, 409);
        }
        const [row] = await insertDraft(db, {
          id: crypto.randomUUID(),
          did,
          title: parsed.data.title,
          dek: parsed.data.dek,
          content,
        });
        return json(
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
          return json({ ok: false, error: "cross_site" }, 403);
        const did = await requireDid(request);
        if (!did) return json({ ok: false, error: "not_signed_in" }, 401);
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!isDraftId(id)) return json({ ok: false, error: "not_found" }, 404);
        const rows = await deleteDraft(drizzle(env.DB), did, id);
        if (rows.length === 0) {
          return json({ ok: false, error: "not_found" }, 404);
        }
        return json({ ok: true });
      },
    },
  },
});
