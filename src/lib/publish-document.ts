/**
 * The record-writing core of publishing, in one place because it now has three
 * callers: the interactive publish on /api/publish, "publish now" on a schedule
 * that failed, and the hourly cron publishing a scheduled post.
 *
 * All three write the SAME KIND OF RECORD to the writer's own repo, and the
 * rules for doing it — which publication a document attaches to, what happens
 * when the writer hasn't got one yet, which ledger rows are written back
 * afterwards — are policy, not plumbing. Three copies of that policy would
 * drift, and the copy that drifted would be the cron: the one nobody watches.
 *
 * WHAT IS NOT HERE. Cover images, backdated imports, and the edit path stay in
 * ~/routes/api.publish, because they need things only a live request has (a
 * multipart file, the writer in front of the form). A scheduled post therefore
 * publishes without a cover — see `publishStoredDraft`.
 */
import type { Client } from "@atcute/client";
import type { drizzle } from "drizzle-orm/d1";

import { type Did, listRecords, type StandardPublication } from "~/lib/atproto";
import { deleteDraft } from "~/lib/drafts";
import { setPublishedRkey } from "~/lib/import-store";
import {
  buildDocumentRecord,
  buildPublicationRecord,
  generateTid,
  isOwnPublicationUrl,
  parseInlineImagesField,
  toRecordInput,
} from "~/lib/publish";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** The writer's Goldroad-managed publication: URL prefix-matched on our
 * origins (canonical + legacy) so we never touch publication records owned by
 * other apps (e.g. Leaflet). */
export async function findOwnPublication(
  pds: string,
  did: string,
  origins: readonly string[],
) {
  const pubs = await listRecords<StandardPublication>(
    pds,
    did,
    "site.standard.publication",
    { reverse: true },
  ).catch(() => []);
  return pubs.find((p) => isOwnPublicationUrl(p.value.url, origins)) ?? null;
}

/**
 * What a new document's `site` field should point at: the writer's own
 * publication record, auto-creating it on their first publish (name defaults to
 * the handle; editable later in /settings). Falls back to the publication's
 * https URL — a "loose document", which the lexicon allows — when there is no
 * PDS to ask or the auto-create didn't land, because a document with an honest
 * URL beats a publish refused over bookkeeping.
 */
export async function resolvePublicationSite(input: {
  rpc: Client;
  did: Did;
  ident: string;
  pds: string | null;
  origin: string;
  origins: readonly string[];
}): Promise<string> {
  const { rpc, did, ident, pds, origin, origins } = input;
  const publicationUrl = `${origin}/@${ident}`;
  if (!pds) return publicationUrl;

  const own = await findOwnPublication(pds, did, origins);
  if (own) return own.uri;

  const pubRkey = generateTid();
  const created = await rpc
    .post("com.atproto.repo.createRecord", {
      input: {
        repo: did,
        collection: "site.standard.publication",
        rkey: pubRkey,
        record: buildPublicationRecord({ name: ident, url: publicationUrl }),
      },
    })
    .catch(() => null);
  if (created?.ok) return `at://${did}/site.standard.publication/${pubRkey}`;
  if (created) console.warn("publication auto-create failed", created.data);
  return publicationUrl;
}

/** A stored draft, as the two draft-publishing callers read it. */
export type StoredDraft = {
  id: string;
  title: string;
  dek: string;
  /** The markdown projection saved with the blocks (~/db/schema). */
  markdown: string;
  /** The body images' blob references, saved with that projection. */
  inlineImages: string;
};

/**
 * The outcome of publishing a stored draft, in two vocabularies on purpose:
 *
 * - `reason` is a sentence for the WRITER. It is stored in
 *   `scheduled_posts.last_error` and rendered verbatim in the posts manager, so
 *   it has to read like something a person wrote to them. Never a status code.
 * - `code` is for the redirect query string on the interactive path, where the
 *   existing `ERROR_MESSAGES` tables turn codes into copy.
 * - `retry` is a judgement about the FAILURE, not the post: a PDS that answered
 *   502 is worth another hour, a refused record is not. Only this layer can
 *   tell them apart, which is why the cron doesn't try to.
 */
export type StoredDraftPublish =
  | { ok: true; rkey: string }
  | { ok: false; retry: boolean; reason: string; code: string };

/** Transient by nature: the PDS was there but unwilling right now. Anything
 * else (a 400 over a malformed record, a 403 over scope) will be just as true
 * next hour, so it fails for good instead of hammering. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Publishes a stored draft as a `site.standard.document` in the writer's repo.
 *
 * NO COVER IMAGE: a cover is a multipart upload from the browser, and there is
 * no browser here. A scheduled post publishes text and the writer adds a cover
 * by editing the post afterwards — which is stated where they schedule, not
 * discovered afterwards. BODY images are different and are carried: they were
 * uploaded to the writer's repo while they wrote, and their references travel
 * with the draft precisely so this can reference them.
 *
 * The two write-backs at the end are best-effort by the same reasoning the
 * interactive path uses: the record is already live in the writer's repo, so a
 * flaked ledger update costs the mirror treatment and a flaked draft delete
 * costs one manual tidy — never the publish, and never a second attempt at it.
 */
export async function publishStoredDraft(input: {
  rpc: Client;
  db: DrizzleD1;
  did: Did;
  ident: string;
  pds: string | null;
  origin: string;
  origins: readonly string[];
  draft: StoredDraft;
}): Promise<StoredDraftPublish> {
  const { rpc, db, did, ident, pds, origin, origins, draft } = input;
  const title = draft.title.trim();
  if (!title)
    return {
      ok: false,
      retry: false,
      reason:
        "This draft has no title, so there was nothing to publish. Add a title and schedule it again.",
      code: "missing_title",
    };

  const rkey = generateTid();
  const site = await resolvePublicationSite({
    rpc,
    did,
    ident,
    pds,
    origin,
    origins,
  });

  let record: ReturnType<typeof buildDocumentRecord>;
  try {
    record = buildDocumentRecord({
      title,
      body: draft.markdown,
      dek: draft.dek,
      site,
      path: `/${rkey}`,
      // The body's own images. A PDS only serves a blob some record references,
      // so publishing without these would produce a post whose pictures are
      // broken — and the browser's per-session store of them is long gone by
      // the time a cron runs. The record builder keeps only the blobs the body
      // still references, and only if they validate.
      inlineImageSources: parseInlineImagesField(draft.inlineImages),
    });
  } catch (err) {
    console.warn("scheduled record build refused", err);
    return {
      ok: false,
      retry: false,
      reason:
        "This draft couldn't be turned into a post — its title or body is outside what a record allows.",
      code: "publish_failed:invalid_record",
    };
  }

  const res = await rpc.post("com.atproto.repo.createRecord", {
    input: {
      repo: did,
      collection: "site.standard.document",
      rkey,
      // The one seam where a document record crosses into the XRPC input —
      // shared with the interactive path rather than re-widened here.
      record: toRecordInput(record),
    },
  });
  // @atcute/client does not throw on XRPC errors — check ok explicitly.
  if (!res.ok) {
    console.error("stored-draft createRecord failed", res.status, res.data);
    const retry = isTransientStatus(res.status);
    return {
      ok: false,
      retry,
      reason: retry
        ? `Your data server couldn't take the post just now (${res.data.error}). Goldroad will try again within the hour.`
        : `Your data server refused the post (${res.data.error}).`,
      code: `publish_failed:${res.data.error}`,
    };
  }

  // Import ledger write-back: an imported draft's row records the rkey it
  // published under, which is what makes the reader page treat it as a mirror
  // and what keeps a re-import refusing it as a duplicate.
  await setPublishedRkey(db, did, draft.id, rkey).catch((err) => {
    console.warn("import ledger write-back failed", err);
  });
  // The publish completes the draft.
  await deleteDraft(db, did, draft.id).catch((err) => {
    console.warn("draft cleanup after publish failed", err);
  });

  return { ok: true, rkey };
}
