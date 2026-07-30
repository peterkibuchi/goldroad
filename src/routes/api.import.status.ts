/**
 * Import-status API — the export-upload path's counterpart to /api/import's
 * flag computation. The browser parsed the writer's Substack export locally
 * (the zip never reaches us), hashed each post's guid, and asks two things
 * before showing the picker: which of these are already imported, and how
 * much draft headroom remains.
 *
 * The payload is HASHES, not guids: fixed-width, nothing content-derived
 * crosses the wire, and the ledger stores hashes anyway. The flags are
 * advisory UI — /api/import/draft re-hashes and re-checks server-side on
 * every save, so a client lying here only mislabels its own picker.
 *
 * Trust posture (same order as /api/import): session cookie → DID;
 * same-origin check; byte cap before parsing; zod. No rate limit beyond the
 * session gate — this endpoint fetches nothing and writes nothing, and its
 * cost is bounded by construction: indexed reads over the caller's own rows,
 * batched into three D1 calls however many hashes arrive (~/lib/import-flags).
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { isDid } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { countDrafts } from "~/lib/drafts";
import { MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import { isCrossSite } from "~/lib/import";
import { computeImportedSet } from "~/lib/import-flags";
import { MAX_EXPORT_POSTS } from "~/lib/import-zip";
import { readLiveSessionDid } from "~/lib/live-session";
import { env } from "cloudflare:workers";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

const statusPayload = z.object({
  guidHashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(MAX_EXPORT_POSTS),
});

/** 1000 hashes × 67 JSON-encoded bytes ≈ 67 KB; double it for headroom. */
const MAX_STATUS_BODY_BYTES = 128 * 1024;

export const Route = createFileRoute("/api/import/status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return json({ ok: false, error: "cross_site" }, 403);
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did))
          return json({ ok: false, error: "not_signed_in" }, 401);

        const raw = await readBodyCapped(request, MAX_STATUS_BODY_BYTES);
        if (raw === null) return json({ ok: false, error: "too_large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }
        const parsed = statusPayload.safeParse(body);
        if (!parsed.success) return json({ ok: false, error: "invalid" }, 400);

        const db = drizzle(env.DB);
        // Concurrent, not sequential: the headroom count doesn't depend on the
        // flags. With the batched lookups in ~/lib/import-flags that puts a
        // full 1000-post archive at three D1 calls in two waves, flat.
        const [imported, [{ n: draftCount }]] = await Promise.all([
          computeImportedSet(db, did, parsed.data.guidHashes),
          countDrafts(db, did),
        ]);
        return json({
          ok: true,
          draftSlotsRemaining: Math.max(0, MAX_DRAFTS_PER_USER - draftCount),
          alreadyImported: [...imported],
        });
      },
    },
  },
});
