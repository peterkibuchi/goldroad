/**
 * Account data export — the "Download your data" action on /settings ("Your
 * data" section). Assembles what WE hold for the signed-in DID into one
 * JSON attachment: full draft content, the import ledger, scheduled posts, and
 * the daily follower-count history, all from our D1 (ownership enforced in
 * ~/lib/rights-store's SQL, same contract as ~/lib/drafts and
 * ~/lib/import-store).
 *
 * ONE DELIBERATE OMISSION, stated in the manifest and reported as a count:
 * the addresses readers left with this writer's publication. They are keyed to
 * the writer's DID, so the account DELETION reaches them — but they are third
 * parties' personal data, and a subject-access export is not a lawful route to
 * a list of other people's email addresses. See ~/lib/rights-store.
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
 * trigger it) with the shared Origin defense-in-depth (isCrossSite,
 * ~/lib/origin) — this is a JS `fetch()` call from /settings, not a page
 * navigation.
 */
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import {
  isDid,
  listRecords,
  resolveDidIdentity,
  type StandardDocument,
} from "~/lib/atproto";
import { readLiveSessionDid } from "~/lib/live-session";
import { canonicalOrigin, isCrossSite } from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import {
  countReaderEmailsForDid,
  selectDraftsForExport,
  selectFollowerSnapshotsForExport,
  selectImportItemsForExport,
  selectScheduledPostsForExport,
} from "~/lib/rights-store";
import { env } from "cloudflare:workers";

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
          return privateJson({ ok: false, error: "cross_site" }, 403);
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did))
          return privateJson({ ok: false, error: "not_signed_in" }, 401);

        const url = new URL(request.url);
        const origin = canonicalOrigin(url.origin);
        const db = drizzle(env.DB);

        const [
          draftRows,
          ledgerRows,
          followerRows,
          scheduleRows,
          readerEmailRows,
          { handle, pds },
        ] = await Promise.all([
          selectDraftsForExport(db, did),
          selectImportItemsForExport(db, did),
          selectFollowerSnapshotsForExport(db, did),
          selectScheduledPostsForExport(db, did),
          // Counted, never listed — see ~/lib/rights-store for why an export
          // of your data is not a place to hand you other people's addresses.
          countReaderEmailsForDid(db, did),
          resolveDidIdentity(did),
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
            "Goldroad stores remarkably little for your account: your drafts, " +
            "import history, scheduled posts and daily follower counts below, " +
            "plus a record of your sign-in session. One more thing is keyed to " +
            "your DID and is deliberately NOT reproduced here: the email " +
            "addresses readers have left with your publication (see " +
            "`readerList` for how many). Those addresses are the readers', not " +
            "yours — they gave them to your publication, and an export of your " +
            "data is not the place we hand over other people's. They are " +
            "deleted along with everything else if you delete your account. " +
            "Nothing else we hold is keyed to your " +
            "DID. This file does NOT include an email address you may have given our " +
            "waitlist form or left on an abuse report: those rows are keyed by " +
            "the email alone, with no DID, so nothing here can prove they are " +
            "yours — mail privacy@trygoldroad.com to have one deleted by hand. " +
            "`followerHistory` is your own " +
            "public follower count, read once a day and kept because Bluesky " +
            "only ever reports today's number — nobody can reconstruct the past " +
            "from it, so we write it down while it's true. Your published posts " +
            "live in your own atproto data repo, not in our database, so " +
            "deleting your Goldroad account never touches them. `ownPosts` is a " +
            "best-effort convenience listing read live from your repo (not from " +
            "our storage); use `pdsRepoExportUrl` to export your entire repo " +
            "yourself, any time, with or without Goldroad.",
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
          scheduledPosts: scheduleRows.map((row) => ({
            draftId: row.draftId,
            dueAt: row.dueAt.toISOString(),
            status: row.status,
            attempts: row.attempts,
            // Our own account of why a post of theirs did not go out — theirs
            // to read in full, verbatim, not summarised.
            lastError: row.lastError,
            publishedRkey: row.publishedRkey,
            createdAt: row.createdAt.toISOString(),
          })),
          followerHistory: followerRows.map((row) => ({
            day: row.day,
            followers: row.followers,
            posts: row.posts,
          })),
          // The count is a fact about YOUR publication and yours to have; the
          // addresses are the readers'. Stated as a field rather than left to
          // the manifest prose so the omission is visible in the data, not
          // only in a paragraph.
          readerList: {
            count: readerEmailRows.length,
            addressesIncluded: false,
            note: "Readers' email addresses are not exported: they are the readers' personal data, left with your publication. They are deleted when you delete your account.",
          },
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
            // Same policy as privateJson — this is the most private payload
            // the app serves; it just isn't shaped like the error responses.
            "cache-control": "private, no-store",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-type": "application/json",
          },
        });
      },
    },
  },
});
