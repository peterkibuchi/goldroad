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

import {
  type AnnounceIntent,
  type AssociatedRef,
  type AutoAnnounceSkip,
  autoAnnounceSkip,
  buildAnnouncePost,
  createAnnouncement,
} from "~/lib/announce";
import {
  consumeAutoAnnounceBudget,
  withinAutoAnnounceBudget,
} from "~/lib/announce-prefs";
import { type Did, listRecords, type StandardPublication } from "~/lib/atproto";
import { thumbFromCover } from "~/lib/blob";
import { deleteDraft } from "~/lib/drafts";
import { setPublishedRkey } from "~/lib/import-store";
import { anyHidden, recordAtUri } from "~/lib/moderation";
import {
  buildDocumentRecord,
  buildPublicationRecord,
  composeDocumentUrl,
  type DocumentRecord,
  generateTid,
  isOwnPublicationUrl,
  parseInlineImagesField,
  toRecordInput,
} from "~/lib/publish";
import { deleteSchedulesForDraft } from "~/lib/scheduled-posts";

type DrizzleD1 = ReturnType<typeof drizzle>;

/**
 * The writer's Goldroad-managed publication: URL prefix-matched on our origins
 * (canonical + legacy) so we never touch publication records owned by other
 * apps (e.g. Leaflet).
 *
 * `ok` separates "they have none" from "we couldn't ask", because every caller
 * writes to this collection and the two states want opposite behaviour. Read as
 * one, a flaked PDS read looks like a first-time writer, and the write that
 * follows creates a SECOND publication record — permanent, public, carrying
 * their name, and invisible to every later lookup (`reverse: true` is
 * oldest-first, so the original keeps winning). Callers must decide explicitly.
 */
export async function findOwnPublication(
  pds: string,
  did: string,
  origins: readonly string[],
) {
  let pubs: Awaited<ReturnType<typeof listRecords<StandardPublication>>>;
  try {
    pubs = await listRecords<StandardPublication>(
      pds,
      did,
      "site.standard.publication",
      { reverse: true },
    );
  } catch (err) {
    console.warn("publication read failed", err);
    return { ok: false as const, own: null };
  }
  const own =
    pubs.find((p) => isOwnPublicationUrl(p.value.url, origins)) ?? null;
  return { ok: true as const, own };
}

/**
 * What a new document attaches to.
 *
 * `site` is the record field; the other two are what announcing needs and what
 * every caller of this function already had to hand. They are returned rather
 * than re-read because the alternative — the shape this replaced — was an
 * announce path that fetched the document and its publication back out of the
 * PDS to learn things the publish had just written: two round trips per post to
 * recover a URL and a strongRef that were in scope a few lines earlier.
 */
export type ResolvedSite = {
  /** document.site — an at:// publication URI, or an https URL (loose). */
  site: string;
  /** The publication's https URL — the base a canonical document URL composes
   * from. Known even for a loose document, because we minted it. */
  publicationUrl: string;
  /** The publication's strongRef, for the announce card's associatedRefs. Null
   * when the document is loose: there is no record to point at. */
  ref: AssociatedRef | null;
};

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
}): Promise<ResolvedSite> {
  const { rpc, did, ident, pds, origin, origins } = input;
  const publicationUrl = `${origin}/@${ident}`;
  const loose: ResolvedSite = {
    site: publicationUrl,
    publicationUrl,
    ref: null,
  };
  if (!pds) return loose;

  const { ok, own } = await findOwnPublication(pds, did, origins);
  if (own)
    return {
      site: own.uri,
      // The record's own URL, not the one we would mint: a writer who has not
      // moved off a legacy origin still has their posts composed under it.
      publicationUrl:
        typeof own.value.url === "string" ? own.value.url : publicationUrl,
      ref: { uri: own.uri, cid: own.cid },
    };
  // Couldn't ask — so we don't know they have none, and creating one on that
  // guess is how a writer ends up with two. A loose document is the honest
  // outcome here, and it is the same one this function already falls back to.
  if (!ok) return loose;

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
  if (created?.ok) {
    const uri = `at://${did}/site.standard.publication/${pubRkey}`;
    return {
      site: uri,
      publicationUrl,
      // createRecord returns the strongRef, so a first-ever publish can carry
      // its brand-new publication in the announce card too.
      ref: created.data.cid ? { uri, cid: created.data.cid } : null,
    };
  }
  if (created) console.warn("publication auto-create failed", created.data);
  return loose;
}

/**
 * What announcing a fresh publish did, in the vocabulary its two callers need.
 * Never a thrown error and never a failed publish: by the time this is
 * reported, the document is already live in the writer's repo.
 */
export type AnnounceReport =
  | { state: "skipped"; reason: AutoAnnounceSkip }
  | { state: "announced"; postRkey: string | null; wroteBack: boolean }
  | {
      state: "failed";
      reason: "scope" | "refused" | "already_announced";
      detail?: string;
    };

/**
 * Announce a document that was just created — the auto path, shared by the
 * interactive publish and the two draft-publishing callers.
 *
 * IT RUNS AFTER THE COMMIT AND CANNOT UNDO IT. Everything here is reported
 * upward and nothing is thrown: the post exists, the writer published it, and a
 * Bluesky card that didn't happen is a smaller problem than a publish that
 * appears to have failed. The callers turn a failure into something a person
 * reads — a notice for the writer on the interactive path, the cron's operator
 * failure list where nobody is watching.
 *
 * FIRST PUBLISH ONLY. There is no edit branch here and there must not be one:
 * see the residual note on `createAnnouncement` for what an edit-time auto
 * announce would cost when a write-back has been lost.
 */
export async function announceNewDocument(input: {
  rpc: Client;
  db: DrizzleD1;
  did: Did;
  ident: string;
  /** The document's record key. */
  rkey: string;
  /** The record as written, and the strongRef createRecord answered with. */
  record: DocumentRecord;
  created: { uri: string; cid: string };
  publication: Pick<ResolvedSite, "publicationUrl" | "ref">;
  /** Origin the fallback URL is minted from (~/lib/origin). */
  origin: string;
  intent: AnnounceIntent;
  /** This post came from an import — its ledger row exists. */
  imported: boolean;
  now?: Date;
}): Promise<AnnounceReport> {
  const {
    rpc,
    db,
    did,
    ident,
    rkey,
    record,
    created,
    publication,
    origin,
    intent,
    imported,
    now = new Date(),
  } = input;

  // Cheapest first: a writer who turned this off costs no query at all.
  if (!intent.requested) return { state: "skipped", reason: "not_requested" };

  // FAIL CLOSED, deliberately the opposite of the reader path. ~/lib/moderation
  // treats a D1 error as "not hidden" because a store outage must not blank the
  // whole reader — availability over enforcement, for a page somebody asked to
  // see. This is not that: nobody asked for this post to appear in their
  // timeline, we would be putting it there, and a takedown we couldn't read is
  // exactly when we should not be amplifying. The cost of being wrong here is
  // one press of "Announce"; the cost the other way is broadcasting content
  // under a legal takedown.
  const hidden = await anyHidden(db, [
    did,
    recordAtUri(did, "site.standard.document", rkey),
  ]).catch((err) => {
    console.warn("announce takedown check failed — not announcing", err);
    return true;
  });

  const publishedAt =
    typeof record.publishedAt === "string"
      ? new Date(record.publishedAt)
      : null;
  const skip = autoAnnounceSkip({
    requested: true,
    imported,
    hidden,
    publishedAt,
    now: now.getTime(),
  });
  if (skip) {
    console.log("auto announce skipped", skip, intent.source, rkey);
    return { state: "skipped", reason: skip };
  }

  // Spending the slot is the last thing before the write, so a post refused on
  // any ground above doesn't cost the writer one.
  const [budget] = await consumeAutoAnnounceBudget(db, did, now).catch(
    () => [],
  );
  // A budget we couldn't spend is a budget we can't prove — and this is the one
  // guard whose whole job is to bound an unattended path, so it fails closed too.
  if (!budget || !withinAutoAnnounceBudget(budget.spent)) {
    console.warn(
      "auto announce over budget",
      intent.source,
      rkey,
      budget?.spent,
    );
    return { state: "skipped", reason: "over_budget" };
  }

  const url =
    composeDocumentUrl({
      site: record.site,
      path: record.path,
      publicationUrl: publication.publicationUrl,
    }) ?? `${origin}/@${encodeURIComponent(ident)}/${rkey}`;

  const associatedRefs: AssociatedRef[] = [
    { uri: created.uri, cid: created.cid },
  ];
  if (publication.ref) associatedRefs.push(publication.ref);

  const result = await createAnnouncement({
    rpc,
    did,
    rkey,
    post: buildAnnouncePost({
      title: record.title,
      url,
      description: record.description,
      associatedRefs,
      // Same repo, so the post's own reference keeps the blob alive; skipped
      // over the thumb lexicon's 1MB cap, which would fail the whole announce.
      thumb: thumbFromCover(record.coverImage) ?? undefined,
    }),
    document: { record: toRecordInput(record), cid: created.cid },
  });
  if (!result.ok)
    return { state: "failed", reason: result.reason, detail: result.detail };
  return {
    state: "announced",
    postRkey: result.postRkey,
    wroteBack: result.wroteBack,
  };
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
  | { ok: true; rkey: string; announce: AnnounceReport }
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
 *
 * ANNOUNCING IS THE LAST THING AND IS REPORTED, NOT RETURNED AS FAILURE. The
 * decision arrives with the caller (`announce`) rather than being read from the
 * writer's account here: the cron must publish the decision the writer made when
 * they scheduled the post, not the one their settings hold at 09:00.
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
  /** Required, not optional: a new caller has to say what it wants, and a bulk
   * one says `NEVER_ANNOUNCE` (~/lib/announce). */
  announce: AnnounceIntent;
}): Promise<StoredDraftPublish> {
  const { rpc, db, did, ident, pds, origin, origins, draft, announce } = input;
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
  const publication = await resolvePublicationSite({
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
      site: publication.site,
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
  //
  // Its RESULT is also how this path knows the draft was imported — a matched
  // row means a ledger entry exists — so the announce skip below costs no
  // second query. A write-back that failed reports no rows, which reads as "not
  // imported": the backdate guard in `autoAnnounceSkip` is the second net under
  // exactly that case, which is why it exists.
  const ledgerRows = await setPublishedRkey(db, did, draft.id, rkey).catch(
    (err) => {
      console.warn("import ledger write-back failed", err);
      return [] as { id: number }[];
    },
  );
  // The publish completes the draft — and with it any schedule pointing at it.
  // A row that outlives its own published post is not harmless: the next tick
  // finds the draft gone and writes DRAFT_GONE_REASON, so the posts manager
  // reports a failure for a post that is live. Best-effort, like every other
  // write-back here, and safe to call when there is no schedule (zero rows).
  await Promise.all([
    deleteDraft(db, did, draft.id).catch((err) => {
      console.warn("draft cleanup after publish failed", err);
    }),
    deleteSchedulesForDraft(db, did, draft.id).catch((err) => {
      console.warn("schedule cleanup after publish failed", err);
    }),
  ]);

  // Strictly after the commit and everything that follows from it. A throw here
  // would lose a published post's bookkeeping to a Bluesky problem, so the whole
  // step is guarded: the publish has already succeeded and says so.
  const announced = await announceNewDocument({
    rpc,
    db,
    did,
    ident,
    rkey,
    record,
    created: { uri: res.data.uri, cid: res.data.cid },
    publication,
    origin,
    intent: announce,
    imported: ledgerRows.length > 0,
  }).catch((err) => {
    console.error("auto announce threw after publish", rkey, err);
    return { state: "failed", reason: "refused", detail: "threw" } as const;
  });

  return { ok: true, rkey, announce: announced };
}
