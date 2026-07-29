/**
 * Account data export — the "Download your data" action on /settings ("Your
 * data" section). Assembles everything WE hold for the signed-in DID into one
 * JSON attachment: full draft content and the import ledger, both from our D1
 * (ownership enforced in ~/lib/rights-store's SQL, same contract as
 * ~/lib/drafts and ~/lib/import-store).
 *
 * ARCHITECTURAL NOTE, worth restating here: your published posts are NOT in
 * this export, because they are not in our database — they live in your own
 * atproto repo. The `ownPosts` section below is a best-effort convenience
 * listing (read live from your PDS, the same public read path the dashboard
 * uses), plus a pointer to export your whole repo yourself at any time. A
 * flaked PDS read must never fail the export of what we DO hold, so `ownPosts`
 * degrades to `null` rather than a failed response.
 *
 * Session-authed POST (not a plain download link, so a signed-out tab can't
 * trigger it) with the same Origin defense-in-depth as ~/routes/api.drafts —
 * this is a JS `fetch()` call from /settings, not a page navigation.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import {
  isDid,
  listRecords,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
} from "~/lib/atproto";
import { canonicalOrigin } from "~/lib/origin";
import {
  selectDraftsForExport,
  selectImportItemsForExport,
} from "~/lib/rights-store";
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

/** Same check as ~/routes/api.drafts: SameSite=Lax already keeps the session
 * cookie off cross-site fetches, this is one more header comparison. */
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** Stored draft content is our own JSON.stringify output (see ~/routes/api.drafts) —
 * a parse failure means a corrupt row. Exports that row's content as `null`
 * rather than 500ing the whole export over one bad row. */
function parseStoredContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/account/export")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request))
          return json({ ok: false, error: "cross_site" }, 403);
        const did = await readSessionDid(request, env.COOKIE_SECRET);
        if (!did || !isDid(did))
          return json({ ok: false, error: "not_signed_in" }, 401);

        const url = new URL(request.url);
        const origin = canonicalOrigin(url.origin);
        const db = drizzle(env.DB);

        const [draftRows, ledgerRows, handle, pds] = await Promise.all([
          selectDraftsForExport(db, did),
          selectImportItemsForExport(db, did),
          resolveDidToHandle(did).catch(() => null),
          resolveDidToPds(did).catch(() => null),
        ]);
        const ident = handle ?? did;

        // Best-effort convenience listing only — never blocks the export of
        // our own data. One page (≤ MAX_LIST_RECORDS): enough to be useful
        // without the worker paying for an unbounded PDS pagination loop;
        // the repo export pointer below covers the rest.
        let ownPosts:
          | {
              uri: string;
              path?: string;
              title?: string;
              publishedAt?: string;
            }[]
          | null = null;
        if (pds) {
          try {
            const docs = await listRecords<StandardDocument>(
              pds,
              did,
              "site.standard.document",
            );
            ownPosts = docs.map((d) => ({
              uri: d.uri,
              path: typeof d.value.path === "string" ? d.value.path : undefined,
              title:
                typeof d.value.title === "string" ? d.value.title : undefined,
              publishedAt:
                typeof d.value.publishedAt === "string"
                  ? d.value.publishedAt
                  : undefined,
            }));
          } catch {
            ownPosts = null;
          }
        }

        const body = {
          exportedAt: new Date().toISOString(),
          account: { did, handle: handle ?? null },
          manifest:
            "Goldroad stores remarkably little for your account: your drafts and " +
            "import history below, plus a record of your sign-in session — that's " +
            "it. Your published posts live in your own atproto data repo, not in " +
            "our database, so deleting your Goldroad account never touches them. " +
            "`ownPosts` is a best-effort convenience listing read live from your " +
            "repo (not from our storage); use `pdsRepoExportUrl` to export your " +
            "entire repo yourself, any time, with or without Goldroad.",
          drafts: draftRows.map((row) => ({
            id: row.id,
            title: row.title,
            content: parseStoredContent(row.content),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })),
          importLedger: ledgerRows.map((row) => ({
            id: row.id,
            sourceUrl: row.sourceUrl,
            originalAt: row.originalAt?.toISOString() ?? null,
            draftId: row.draftId,
            publishedRkey: row.publishedRkey,
            adoptedAt: row.adoptedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          })),
          ownPosts: {
            publicPage: `${origin}/@${encodeURIComponent(ident)}`,
            pdsRepoExportUrl: pds
              ? `${pds}/xrpc/com.atproto.repo.getRepo?did=${encodeURIComponent(did)}`
              : null,
            posts: ownPosts,
          },
        };

        const filename = `goldroad-data-${new Date().toISOString().slice(0, 10)}.json`;
        return new Response(JSON.stringify(body, null, 2), {
          headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-type": "application/json",
          },
        });
      },
    },
  },
});
