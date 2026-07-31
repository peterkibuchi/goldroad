// Registers com.atproto.* XRPC procedure types (typed createRecord/putRecord below).
import type {} from "@atcute/atproto";
import { Client } from "@atcute/client";
import type { OAuthSession } from "@atcute/oauth-node-client";
import { createFileRoute } from "@tanstack/react-router";
import { drizzle } from "drizzle-orm/d1";

import { type AssociatedRef, buildAnnouncePost } from "~/lib/announce";
import {
  getRecordEntry,
  isDid,
  parseAtUri,
  RKEY_RE,
  resolveDidToHandle,
  resolveDidToPds,
  rkeyFromUri,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import {
  blobImagePath,
  isAllowedImageMime,
  isBlobCid,
  isBlobObject,
  MAX_IMAGE_BLOB_BYTES,
  thumbFromCover,
} from "~/lib/blob";
import { deleteDraft, selectDraft } from "~/lib/drafts";
import { isDraftId } from "~/lib/drafts-schema";
import { clampOriginalDate, rehostBodyImages } from "~/lib/import";
import {
  adoptMirror,
  clearPublishedImport,
  selectImportItemByDraft,
  setPublishedRkey,
} from "~/lib/import-store";
import { readLiveSessionDid } from "~/lib/live-session";
import { createOAuthClient } from "~/lib/oauth";
import {
  CANONICAL_ORIGIN,
  canonicalOrigin,
  isCrossSite,
  LEGACY_ORIGINS,
  ownOrigins,
} from "~/lib/origin";
import { privateJson } from "~/lib/private-json";
import {
  buildDocumentRecord,
  buildPublicationRecord,
  type CoverImageBlob,
  composeDocumentUrl,
  generateTid,
  type IconBlob,
  isOwnPublicationUrl,
  MAX_BODY_LENGTH,
  MAX_DEK_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PUBLICATION_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  parseInlineImagesField,
  TID_RE,
  toRecordInput,
  updateDocumentRecord,
  withBasicTheme,
} from "~/lib/publish";
import {
  findOwnPublication,
  publishStoredDraft,
  resolvePublicationSite,
} from "~/lib/publish-document";
import { dueAtProblem, localToUtcMs } from "~/lib/schedule-time";
import {
  cancelSchedule,
  deleteSchedulesForDraft,
  deleteUnclaimedSchedulesForDraft,
  selectScheduleForDraft,
  upsertSchedule,
} from "~/lib/scheduled-posts";
import { clearSessionCookies } from "~/lib/session";
import { parseThemeForm } from "~/lib/theme";
import { env } from "cloudflare:workers";

function redirectTo(location: string, extra?: HeadersInit): Response {
  return new Response(null, {
    status: 303,
    headers: { location, ...extra },
  });
}

function backToWrite(error: string, editRkey?: string): Response {
  const params = new URLSearchParams({ error });
  if (editRkey) params.set("edit", editRkey);
  return redirectTo(`/write?${params}`);
}

/** Back to the editor with the draft still loaded. A bare /write?error would
 * strand the writer on a blank page with their words "somewhere" — technically
 * saved, and no comfort at all. */
function backToDraft(draftId: string, error: string): Response {
  const params = new URLSearchParams({ error });
  if (isDraftId(draftId)) params.set("draft", draftId);
  return redirectTo(`/write?${params}`);
}

function backToSettings(error?: string): Response {
  return redirectTo(
    error
      ? `/settings?error=${encodeURIComponent(error)}`
      : "/settings?saved=1",
  );
}

function backToDashboard(query: Record<string, string>): Response {
  return redirectTo(`/dashboard?${new URLSearchParams(query)}`);
}

/**
 * Was this XRPC write rejected for missing OAuth permission? Tokens carry the
 * scope granted at consent time, so sessions created before a scope addition
 * (delete action, app.bsky.feed.post — see SCOPES in ~/lib/oauth) hit this.
 * The PDS answers 401/403 (error naming varies across implementations — the
 * session was just restored, so a 401 here is a stale grant, not a stale
 * token). Fixed by a fresh sign-in: re-consent picks up the current scope.
 */
function isInsufficientScope(res: { ok: boolean; status: number }): boolean {
  return !res.ok && (res.status === 401 || res.status === 403);
}

/**
 * The single write path to the user's PDS. ALL record writes (documents and
 * publications, discriminated by the `intent` form field) go through this one
 * handler so token refreshes are not raced across isolates.
 *
 * CSRF: the same one-header defense-in-depth every other mutating handler
 * runs (isCrossSite, ~/lib/origin), and the most consequential place to run
 * it — this writes public records to the writer's repo, and `intent=delete`
 * removes them. SameSite=Lax is the real barrier; the Origin comparison
 * covers legacy browsers, and it runs before the session is read so a
 * cross-site POST costs nothing. A bare 403 (not a redirect back to /write)
 * is deliberate: no legitimate caller is anything but our own form.
 */
export const Route = createFileRoute("/api/publish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request)) {
          return new Response("Cross-site request refused", { status: 403 });
        }
        const url = new URL(request.url);
        const did = await readLiveSessionDid(
          request,
          env.COOKIE_SECRET,
          drizzle(env.DB),
        );
        if (!did || !isDid(did)) {
          return new Response("Not signed in", { status: 401 });
        }

        const form = await request.formData().catch(() => null);
        if (!form) return new Response("Invalid form", { status: 400 });
        const intentField = form.get("intent");
        const intent =
          intentField === "publication" ||
          intentField === "theme" ||
          intentField === "delete" ||
          intentField === "announce" ||
          intentField === "migrate" ||
          intentField === "uploadImage" ||
          intentField === "schedule" ||
          intentField === "unschedule" ||
          intentField === "publish-now"
            ? intentField
            : "document";

        // Scheduling touches OUR database and nothing else — no record is
        // written, so these two run before the session is restored. That isn't
        // only an economy: restoring a session refreshes the writer's token,
        // and doing that to save a due date would spend a refresh (and widen
        // the race documented in ~/lib/scheduled-posts) for no write at all.
        if (intent === "schedule") return scheduleDraft(form, did);
        if (intent === "unschedule") return unscheduleDraft(form, did);

        const client = createOAuthClient(url.origin);
        let session: OAuthSession;
        try {
          session = await client.restore(did);
        } catch (err) {
          console.warn("session restore failed", err);
          // Sign-in lives on /write for both intents.
          const expired = new Headers({
            location: "/write?error=session_expired",
          });
          for (const cookie of clearSessionCookies(url.protocol === "https:"))
            expired.append("set-cookie", cookie);
          // The image upload is a fetch, not a form post: a 303 to an HTML
          // page would reach it as an unreadable body. Say what happened.
          if (intent === "uploadImage") {
            expired.delete("location");
            expired.set("content-type", "application/json");
            expired.set("cache-control", "private, no-store");
            return new Response(
              JSON.stringify({ ok: false, error: "session_expired" }),
              { status: 401, headers: expired },
            );
          }
          return new Response(null, { status: 303, headers: expired });
        }

        const rpc = new Client({ handler: session });
        const handle = await resolveDidToHandle(did).catch(() => null);
        const ident = handle ?? did; // reader routes accept handle or DID
        const pds = await resolveDidToPds(did).catch(() => null);

        const ctx: WriteContext = {
          rpc,
          form,
          did,
          ident,
          pds,
          // URLs we MINT use the canonical origin; URLs we MATCH (ownership
          // guard) accept every origin we have ever minted from.
          origin: canonicalOrigin(url.origin),
          origins: ownOrigins(url.origin),
        };
        switch (intent) {
          case "publication":
            return savePublication(ctx);
          case "theme":
            return saveTheme(ctx);
          case "delete":
            return deleteDocument(ctx);
          case "announce":
            return announceDocument(ctx);
          case "migrate":
            return migratePublication(ctx);
          case "uploadImage":
            return uploadInlineImage(ctx);
          case "publish-now":
            return publishNow(ctx);
          default:
            return publishDocument(ctx);
        }
      },
    },
  },
});

/**
 * `intent=schedule` — publish this draft at a moment the writer picked.
 *
 * NOT A SECOND WRITE PATH. Nothing here touches the writer's repo: it saves a
 * due date beside a draft id, and the hourly cron does the publishing through
 * the same `publishStoredDraft` the button below uses. Which is also why it
 * runs before the session restore in the handler above.
 *
 * The draft is the payload, so this writes no content: the editor forces a save
 * (blocks AND the markdown projection) and waits for it before submitting, so
 * by the time this runs the row holds exactly what was on screen. What this
 * checks is what a cron hours later cannot recover from — that the draft is
 * really this writer's, and that it has a title.
 *
 * Times arrive as the writer's wall clock plus the zone offset in effect AT
 * THAT MOMENT, and are converted once, here, at the write door
 * (~/lib/schedule-time). Only UTC is stored.
 */
async function scheduleDraft(form: FormData, did: string): Promise<Response> {
  const draftId = String(form.get("draftId") ?? "");
  if (!isDraftId(draftId)) return backToDraft(draftId, "schedule_no_draft");

  const offsetField = form.get("dueTzOffset");
  const offset =
    typeof offsetField === "string" && offsetField.trim() !== ""
      ? Number(offsetField)
      : null;
  // localToUtcMs refuses a null/implausible offset outright — a missing offset
  // must never be read as "UTC, then", which would silently shift every
  // scheduled time by the writer's own offset.
  const dueAt = localToUtcMs(form.get("dueAtLocal"), offset);
  const problem = dueAtProblem(dueAt, Date.now());
  if (problem) return backToDraft(draftId, `schedule_${problem}`);

  const db = drizzle(env.DB);
  const [draft] = await selectDraft(db, did, draftId).catch(() => []);
  // Missing OR not theirs — deliberately the same answer, as everywhere else.
  if (!draft) return backToDraft(draftId, "schedule_no_draft");
  // A titled post is the one thing publishing cannot do without, and finding
  // that out at 09:00 tomorrow is strictly worse than finding out now.
  if (!draft.title.trim()) return backToDraft(draftId, "missing_title");

  try {
    await upsertSchedule(db, {
      id: crypto.randomUUID(),
      did,
      draftId,
      dueAt: new Date(dueAt as number),
    });
  } catch (err) {
    console.error("schedule write failed", err);
    return backToDraft(draftId, "schedule_failed");
  }
  // Land on the queue, not back in the editor: the writer's next question is
  // "is it really going out, and when", and this is the page that answers it.
  return backToDashboard({ tab: "scheduled", scheduled: "1" });
}

/** `intent=unschedule` — cancel. The row is deleted (see cancelSchedule), so
 * the writer is back to simply having a draft. Accepts the schedule's own id
 * (from the posts manager) or the draft id (from the editor, which knows the
 * draft and not the row). */
async function unscheduleDraft(form: FormData, did: string): Promise<Response> {
  const id = String(form.get("id") ?? "");
  const draftId = String(form.get("draftId") ?? "");
  const backToEditor = form.get("returnTo") === "write";
  const db = drizzle(env.DB);
  try {
    if (isDraftId(id)) await cancelSchedule(db, did, id);
    else if (isDraftId(draftId))
      await deleteSchedulesForDraft(db, did, draftId);
    else
      return backToEditor
        ? backToDraft(draftId, "unschedule_failed")
        : backToDashboard({ error: "unschedule_failed", tab: "scheduled" });
  } catch (err) {
    console.error("unschedule failed", err);
    return backToEditor
      ? backToDraft(draftId, "unschedule_failed")
      : backToDashboard({ error: "unschedule_failed", tab: "scheduled" });
  }
  // A cancel that matched nothing reports success: the row is gone either way,
  // which is the state the writer asked for (same reasoning as the idempotent
  // account deletion).
  return backToEditor
    ? redirectTo(`/write?draft=${encodeURIComponent(draftId)}&unscheduled=1`)
    : backToDashboard({ tab: "scheduled", unscheduled: "1" });
}

type WriteContext = {
  rpc: Client;
  form: FormData;
  did: `did:${string}:${string}`;
  ident: string;
  pds: string | null;
  /** Origin new URLs are minted from (canonical in prod, loopback in dev). */
  origin: string;
  /** Origins the ownership guard matches against (canonical + legacy). */
  origins: readonly string[];
};

async function publishDocument({
  rpc,
  form,
  did,
  ident,
  pds,
  origin,
  origins,
}: WriteContext): Promise<Response> {
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "");
  // The subtitle line. Blank (the common case) leaves description generation
  // exactly as it was: the first ~300 characters of the body.
  const dek = String(form.get("dek") ?? "").trim();
  const editRkey = String(form.get("rkey") ?? "");
  if (!title) return backToWrite("missing_title", editRkey || undefined);
  if (
    title.length > MAX_TITLE_LENGTH ||
    body.length > MAX_BODY_LENGTH ||
    dek.length > MAX_DEK_LENGTH
  )
    return backToWrite("too_long", editRkey || undefined);

  // Blobs the editor uploaded for this draft's body images (intent=uploadImage
  // handed them back). Untrusted: the record builders keep only the ones the
  // body still references, and only if they validate as raster blobs in cap.
  const inlineImageSources = parseInlineImagesField(form.get("images"));

  // ---- Cover image: optional multipart file → com.atproto.repo.uploadBlob.
  // Uploaded FIRST so both create and edit reference the returned blob — the
  // record field reference is what stops PDS garbage collection. The client
  // downscales before submitting, but the lexicon caps (image/*, ≤1MB,
  // SVG excluded — script-capable) are enforced here, where they count.
  // If the record write below fails, the fresh blob stays unreferenced and
  // the PDS GC reclaims it — nothing to clean up.
  const coverFile = form.get("cover");
  const removeCover = form.get("removeCover") === "1";
  let coverBlob: CoverImageBlob | undefined;
  if (coverFile instanceof File && coverFile.size > 0) {
    if (!isAllowedImageMime(coverFile.type))
      return backToWrite("cover_type", editRkey || undefined);
    if (coverFile.size > MAX_IMAGE_BLOB_BYTES)
      return backToWrite("cover_too_large", editRkey || undefined);
    const uploaded = await rpc.post("com.atproto.repo.uploadBlob", {
      headers: { "content-type": coverFile.type },
      input: coverFile,
    });
    if (!uploaded.ok) {
      if (isInsufficientScope(uploaded))
        return backToWrite("cover_scope", editRkey || undefined);
      console.error("uploadBlob failed", uploaded.status, uploaded.data);
      return backToWrite(
        `publish_failed:${uploaded.data.error}`,
        editRkey || undefined,
      );
    }
    coverBlob = uploaded.data.blob;
  }

  // ---- Edit: merge into the existing record, preserve its history ----
  if (editRkey) {
    if (!TID_RE.test(editRkey) || !pds) return backToWrite("not_found");
    let existing: Awaited<ReturnType<typeof getRecordEntry<StandardDocument>>>;
    try {
      existing = await getRecordEntry<StandardDocument>(
        pds,
        did,
        "site.standard.document",
        editRkey,
      );
    } catch {
      return backToWrite("not_found");
    }
    if (existing.value.content != null) return backToWrite("not_editable");
    let record: ReturnType<typeof updateDocumentRecord>;
    try {
      record = updateDocumentRecord(existing.value, {
        title,
        body,
        dek,
        // blob = replace, null = remove, undefined = keep the existing cover.
        coverImage: coverBlob ?? (removeCover ? null : undefined),
        inlineImageSources,
      });
    } catch (err) {
      console.warn("record merge refused", err);
      return backToWrite("publish_failed:invalid_record", editRkey);
    }
    // swapRecord pins the version we merged from (adopted from review): an
    // unconditional put here could silently drop a concurrent announce
    // write-back's bskyPostRef. On a swap conflict the PDS answers
    // InvalidSwap → the writer retries against the fresh record.
    const res = await rpc.post("com.atproto.repo.putRecord", {
      input: {
        repo: did,
        collection: "site.standard.document",
        rkey: editRkey,
        record: toRecordInput(record),
        swapRecord: existing.cid,
      },
    });
    if (!res.ok) {
      console.error("putRecord failed", res.status, res.data);
      return backToWrite(`publish_failed:${res.data.error}`, editRkey);
    }
    // Adoption (mirrored posts only): the writer checked "make this the
    // Goldroad original", so the mirror treatment (noindex + provenance
    // line) stops. Best-effort — the edit itself already landed; a flaked
    // flag clear is retried by saving the edit again.
    if (form.get("adoptOriginal") === "1") {
      await adoptMirror(drizzle(env.DB), did, editRkey).catch((err) => {
        console.warn("mirror adoption failed", err);
      });
    }
    return redirectTo(`/@${encodeURIComponent(ident)}/${editRkey}`);
  }

  // ---- Import provenance: a draft that arrived through the feed import
  // carries a ledger row. Publishing it honors the original date — backdated
  // publishedAt AND a backdated TID rkey, so the repo/archive ordering
  // matches when the piece was actually written (accepted-risk decision:
  // imported posts publish with their original date). Read is best-effort:
  // if D1 flakes, the post publishes as a normal now-dated post rather than
  // failing the writer's publish.
  const draftId = String(form.get("draftId") ?? "");
  const [importRow] = isDraftId(draftId)
    ? await selectImportItemByDraft(drizzle(env.DB), did, draftId).catch(
        () => [],
      )
    : [];
  const originalAt = importRow ? clampOriginalDate(importRow.originalAt) : null;

  // ---- Create: attach to the writer's publication (auto-created on first
  // publish — name defaults to the handle; editable later in /settings). The
  // same resolution the scheduled and publish-now paths use, so all three
  // attach documents identically (~/lib/publish-document).
  const rkey = originalAt ? generateTid(originalAt.getTime()) : generateTid();
  const site = await resolvePublicationSite({
    rpc,
    did,
    ident,
    pds,
    origin,
    origins,
  });

  // ---- Imported posts: copy the body images into the writer's own repo.
  // Lazily, for THIS post, at the moment they decide to keep it — never as a
  // bulk job at import, because it spends their repo quota. An imported body
  // points at the source's CDN, which is precisely the copy that vanishes
  // when they leave that platform; rehosting is what makes the archive
  // theirs. Every fetch runs under the feed's SSRF regime (see
  // rehostBodyImages) — an import does not make a writer-supplied URL
  // trusted. Best-effort per image: a miss keeps the original URL.
  let publishBody = body;
  let rehostedBlobs: unknown[] = [];
  if (importRow) {
    const rehosted = await rehostBodyImages({
      body,
      did,
      maxBytes: MAX_IMAGE_BLOB_BYTES,
      isAllowedMime: isAllowedImageMime,
      imagePath: blobImagePath,
      upload: async (bytes, mime) => {
        const uploaded = await rpc
          .post("com.atproto.repo.uploadBlob", {
            headers: { "content-type": mime },
            input: new Blob([bytes], { type: mime }),
          })
          .catch(() => null);
        return uploaded?.ok ? uploaded.data.blob : null;
      },
    }).catch((err) => {
      console.warn("inline image rehost failed", err);
      return null;
    });
    if (rehosted) {
      publishBody = rehosted.body;
      rehostedBlobs = rehosted.blobs;
    }
  }

  // An imported post with no writer-picked cover borrows its first body
  // image — already fetched and uploaded just above, so this costs nothing.
  // thumbFromCover is the same validation a cover gets (raster, ≤1MB).
  if (!coverBlob && rehostedBlobs.length > 0)
    coverBlob = thumbFromCover(rehostedBlobs[0]) ?? undefined;

  // Canonical URL composes as publication.url + path: …/@<ident> + /<rkey>.
  const record = buildDocumentRecord({
    title,
    body: publishBody,
    dek,
    site,
    path: `/${rkey}`,
    coverImage: coverBlob,
    // Rehosted blobs need a record reference exactly as uploaded ones do.
    inlineImageSources: [...inlineImageSources, ...rehostedBlobs],
    publishedAt: originalAt ?? undefined,
  });

  const res = await rpc.post("com.atproto.repo.createRecord", {
    input: {
      repo: did,
      collection: "site.standard.document",
      rkey,
      record: toRecordInput(record),
    },
  });
  // @atcute/client does not throw on XRPC errors — check ok explicitly.
  if (!res.ok) {
    console.error("createRecord failed", res.status, res.data);
    return backToWrite(`publish_failed:${res.data.error}`);
  }

  // Import ledger write-back: record the rkey this item published under —
  // that row is what makes the reader page a "mirror" (noindex + provenance)
  // and what keeps re-imports refusing the item as a duplicate. Best-effort:
  // the record is already live; a flaked write-back costs the mirror
  // treatment, never the publish.
  if (importRow && isDraftId(draftId)) {
    await setPublishedRkey(drizzle(env.DB), did, draftId, rkey).catch((err) => {
      console.warn("import ledger write-back failed", err);
    });
  }

  // A publish that started from an autosaved draft completes it: remove the
  // draft row (ownership enforced in the delete's WHERE). Best-effort — the
  // post is already live; a leftover draft costs one manual delete, never a
  // failed publish.
  if (isDraftId(draftId)) {
    await deleteDraft(drizzle(env.DB), did, draftId).catch((err) => {
      console.warn("draft cleanup after publish failed", err);
    });
  }

  // Success lands on the dashboard: the new post on top, a "view it live"
  // link, and the explicit opt-in "Announce on Bluesky" action.
  return backToDashboard({ published: rkey });
}

/**
 * An inline body image → a blob in the writer's own repo, answered as the
 * same-origin `/img/<did>/<cid>` proxy path the editor writes into the
 * markdown. Same intent, same session, same CSRF gate and same lexicon caps as
 * the cover upload above — a second write path to the PDS is exactly what the
 * one-handler rule exists to prevent.
 *
 * The blob JSON travels back with the URL because the record has to reference
 * it at publish time or the PDS never serves it (see DocumentRecord in
 * ~/lib/publish); the browser hands the collected blobs to the publish form,
 * and this handler's answers are re-validated there.
 *
 * JSON, not a redirect: this is the one intent called by fetch.
 */
async function uploadInlineImage({
  rpc,
  form,
  did,
}: WriteContext): Promise<Response> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return privateJson({ ok: false, error: "no_file" }, 400);
  if (!isAllowedImageMime(file.type))
    return privateJson({ ok: false, error: "image_type" }, 415);
  // The browser downscales first; this is where the lexicon's cap counts.
  if (file.size > MAX_IMAGE_BLOB_BYTES)
    return privateJson({ ok: false, error: "image_too_large" }, 413);

  const uploaded = await rpc
    .post("com.atproto.repo.uploadBlob", {
      headers: { "content-type": file.type },
      input: file,
    })
    .catch((err: unknown) => {
      console.error("inline image uploadBlob threw", err);
      return null;
    });
  if (!uploaded) return privateJson({ ok: false, error: "upload_failed" }, 502);
  if (!uploaded.ok) {
    if (isInsufficientScope(uploaded))
      return privateJson({ ok: false, error: "image_scope" }, 403);
    console.error(
      "inline image uploadBlob failed",
      uploaded.status,
      uploaded.data,
    );
    return privateJson({ ok: false, error: "upload_failed" }, 502);
  }

  // A blob we can't turn into a servable /img path is a failure, not a URL the
  // writer discovers is broken after publishing.
  const blob = uploaded.data.blob;
  const cid = isBlobObject(blob) ? blob.ref.$link : null;
  if (!cid || !isBlobCid(cid)) {
    console.error("inline image uploadBlob returned an unusable blob", blob);
    return privateJson({ ok: false, error: "upload_failed" }, 502);
  }
  return privateJson({ ok: true, url: blobImagePath(did, cid), blob }, 201);
}

/**
 * `intent=publish-now` — the escape hatch beside a scheduled post: publish it
 * this second instead of waiting for (or arguing with) the cron. It is the way
 * out of a FAILED schedule, and the reason a failure is never a dead end.
 *
 * It publishes through the same `publishStoredDraft` the cron uses, so a post
 * that goes out this way is byte-for-byte the post that would have gone out on
 * schedule — no second record shape to keep in step.
 *
 * TAKE THE ROW OUT OF THE QUEUE FIRST, and only if no tick holds its lease.
 * That ordering is the whole double-publish guard on this path: a row that no
 * longer exists cannot be claimed by a tick a moment later, and a row a tick
 * ALREADY claimed means a publish is in flight right now — which this refuses
 * rather than races. The cost of taking the row first is that a publish which
 * then fails leaves the writer with a draft and no schedule (they are told, and
 * the draft is untouched); the cost of the other order is publishing twice.
 */
async function publishNow({
  rpc,
  form,
  did,
  ident,
  pds,
  origin,
  origins,
}: WriteContext): Promise<Response> {
  const draftId = String(form.get("draftId") ?? "");
  if (!isDraftId(draftId))
    return backToDashboard({ error: "schedule_no_draft", tab: "scheduled" });
  const db = drizzle(env.DB);

  const [released] = await deleteUnclaimedSchedulesForDraft(
    db,
    did,
    draftId,
  ).catch(() => []);
  if (!released) {
    const [inFlight] = await selectScheduleForDraft(db, did, draftId).catch(
      () => [],
    );
    // A row still there after an unclaimed-only delete is a claimed row: the
    // cron is publishing it as we speak.
    if (inFlight)
      return backToDashboard({ error: "schedule_in_flight", tab: "scheduled" });
  }

  const [draft] = await selectDraft(db, did, draftId).catch(() => []);
  if (!draft)
    return backToDashboard({ error: "draft_not_found", tab: "scheduled" });

  const outcome = await publishStoredDraft({
    rpc,
    db,
    did,
    ident,
    pds,
    origin,
    origins,
    draft,
  });
  if (!outcome.ok)
    return backToDashboard({ error: outcome.code, tab: "scheduled" });
  return backToDashboard({ published: outcome.rkey });
}

/**
 * Deletes a site.standard.document from the writer's repo.
 *
 * Ownership needs no extra guard: com.atproto.repo.deleteRecord only reaches
 * records under `repo`, which is always the session DID here — so deletion is
 * limited to the writer's own repo by construction. That includes documents
 * authored in other apps (e.g. Leaflet's rich-content-union records): they are
 * not editable here, but they are the writer's records, and
 * removing one deletes the whole record rather than forking its content.
 */
async function deleteDocument({ rpc, form, did }: WriteContext) {
  const rkey = String(form.get("rkey") ?? "");
  if (!RKEY_RE.test(rkey)) return backToDashboard({ error: "missing_rkey" });

  const res = await rpc.post("com.atproto.repo.deleteRecord", {
    input: { repo: did, collection: "site.standard.document", rkey },
  });
  if (!res.ok) {
    if (isInsufficientScope(res))
      return backToDashboard({ error: "delete_scope" });
    console.error("deleteRecord failed", res.status, res.data);
    return backToDashboard({ error: `delete_failed:${res.data.error}` });
  }
  // If the deleted record was an imported mirror, clear the ledger row's
  // publish state — otherwise the feed item would be refused as "already
  // imported" forever after its post is gone. No-op for native posts (zero
  // rows match); best-effort, same policy as the other ledger write-backs.
  await clearPublishedImport(drizzle(env.DB), did, rkey).catch((err) => {
    console.warn("import ledger cleanup after delete failed", err);
  });
  return backToDashboard({ deleted: "1" });
}

/**
 * "Announce on Bluesky": creates an app.bsky.feed.post in the writer's repo —
 * title + canonical URL with a link facet, plus an app.bsky.embed.external
 * carrying associatedRefs strongRefs to the standard.site records (what makes
 * Bluesky render the enriched reader card — see ~/lib/announce). Explicit
 * user action only; nothing here is called from a publish flow automatically.
 */
async function announceDocument({
  rpc,
  form,
  did,
  ident,
  pds,
  origin,
}: WriteContext) {
  const rkey = String(form.get("rkey") ?? "");
  if (!RKEY_RE.test(rkey)) return backToDashboard({ error: "missing_rkey" });
  if (!pds) return backToDashboard({ error: "announce_failed:pds_unresolved" });

  let doc: Awaited<ReturnType<typeof getRecordEntry<StandardDocument>>>;
  try {
    doc = await getRecordEntry<StandardDocument>(
      pds,
      did,
      "site.standard.document",
      rkey,
    );
  } catch {
    return backToDashboard({ error: "not_found" });
  }

  // Resolve the document's publication when `site` is an at:// URI — it gives
  // both the canonical-URL base and the publication strongRef. Only same-repo
  // publications (all records Goldroad writes, and Leaflet's) are followed;
  // a cross-repo ref would mean fetching a different identity's PDS.
  let publicationUrl: string | undefined;
  let publicationRef: AssociatedRef | undefined;
  const siteRef =
    typeof doc.value.site === "string" ? parseAtUri(doc.value.site) : null;
  if (
    siteRef &&
    siteRef.did === did &&
    siteRef.collection === "site.standard.publication"
  ) {
    const pub = await getRecordEntry<StandardPublication>(
      pds,
      siteRef.did,
      siteRef.collection,
      siteRef.rkey,
    ).catch(() => null);
    if (pub) {
      if (typeof pub.value.url === "string") publicationUrl = pub.value.url;
      if (pub.cid && pub.uri) publicationRef = { uri: pub.uri, cid: pub.cid };
    }
  }

  // Canonical composed URL; Goldroad's reader serves any repo document at
  // /@<ident>/<rkey>, so that is the honest fallback when composition fails.
  const url =
    composeDocumentUrl({
      site: doc.value.site,
      path: doc.value.path,
      publicationUrl,
    }) ?? `${origin}/@${encodeURIComponent(ident)}/${rkey}`;

  const associatedRefs: AssociatedRef[] = [];
  if (doc.cid && doc.uri) associatedRefs.push({ uri: doc.uri, cid: doc.cid });
  if (publicationRef) associatedRefs.push(publicationRef);

  const post = buildAnnouncePost({
    title: typeof doc.value.title === "string" ? doc.value.title : "",
    url,
    description:
      typeof doc.value.description === "string"
        ? doc.value.description
        : undefined,
    associatedRefs,
    // Reuse the document's cover blob as the card thumb (same repo — the
    // post's reference keeps it persistence-legal). Skipped when over the
    // thumb lexicon's 1MB cap: the PDS would reject the whole announce.
    thumb: thumbFromCover(doc.value.coverImage) ?? undefined,
  });

  const res = await rpc.post("com.atproto.repo.createRecord", {
    input: { repo: did, collection: "app.bsky.feed.post", record: post },
  });
  if (!res.ok) {
    if (isInsufficientScope(res))
      return backToDashboard({ error: "announce_scope" });
    console.error("announce createRecord failed", res.status, res.data);
    return backToDashboard({ error: `announce_failed:${res.data.error}` });
  }

  // Honest announce status (auto-announce is deferred): write the created post's
  // strongRef into the document's lexicon-native `bskyPostRef` slot, so the
  // dashboard can show "Announced" and the state travels with the record
  // (readable by any app, not just ours). This is NOT an edit of the
  // document's content — every field including a foreign `content` union is
  // preserved — so the not_editable rule doesn't apply.
  // swapRecord pins the version we read: a concurrent edit wins, we never
  // clobber. Requires doc.cid — without it swapRecord would be undefined and
  // the put unconditional, the one way this could stomp a concurrent edit.
  // Best-effort — the announce itself already succeeded, so a failed
  // write-back only costs status honesty; the writer can announce again.
  if (res.data.uri && res.data.cid && doc.cid) {
    const writeBack = await rpc
      .post("com.atproto.repo.putRecord", {
        input: {
          repo: did,
          collection: "site.standard.document",
          rkey,
          record: {
            ...doc.value,
            $type: "site.standard.document",
            bskyPostRef: { uri: res.data.uri, cid: res.data.cid },
          },
          swapRecord: doc.cid,
        },
      })
      .catch(() => null);
    if (!writeBack?.ok)
      console.warn("bskyPostRef write-back failed", writeBack?.data);
  }

  const postRkey = rkeyFromUri(res.data.uri);
  return backToDashboard(postRkey ? { announced: postRkey } : {});
}

async function savePublication({
  rpc,
  form,
  did,
  ident,
  pds,
  origin,
  origins,
}: WriteContext): Promise<Response> {
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "");
  if (!name) return backToSettings("missing_name");
  if (
    name.length > MAX_NAME_LENGTH ||
    description.length > MAX_PUBLICATION_DESCRIPTION_LENGTH
  )
    return backToSettings("too_long");
  if (!pds) return backToSettings("save_failed:pds_unresolved");

  // ---- Icon: optional multipart file → com.atproto.repo.uploadBlob, on the
  // same terms as a document cover (image/*, ≤1MB, SVG excluded — the client
  // squares and shrinks it first, and this is where that is enforced). An
  // upload that outlives a failed record write stays unreferenced and the PDS
  // reclaims it.
  const iconFile = form.get("icon");
  let iconBlob: IconBlob | undefined;
  if (iconFile instanceof File && iconFile.size > 0) {
    if (!isAllowedImageMime(iconFile.type)) return backToSettings("icon_type");
    if (iconFile.size > MAX_IMAGE_BLOB_BYTES)
      return backToSettings("icon_too_large");
    const uploaded = await rpc.post("com.atproto.repo.uploadBlob", {
      headers: { "content-type": iconFile.type },
      input: iconFile,
    });
    if (!uploaded.ok) {
      if (isInsufficientScope(uploaded)) return backToSettings("icon_scope");
      console.error("icon uploadBlob failed", uploaded.status, uploaded.data);
      return backToSettings(`save_failed:${uploaded.data.error}`);
    }
    iconBlob = uploaded.data.blob;
  }
  // Removing an icon is explicit on the wire: an empty file input means
  // "keep the one that's there".
  const removeIcon = form.get("removeIcon") === "1";

  const own = await findOwnPublication(pds, did, origins);
  // Saving never silently rewrites a legacy publication URL — the writer moves
  // it explicitly via the `migrate` intent, so the two changes stay separate.
  const url =
    own && typeof own.value.url === "string"
      ? own.value.url
      : `${origin}/@${ident}`;
  const record = buildPublicationRecord(
    {
      name,
      description,
      url,
      // blob = replace, null = remove, undefined = keep the existing icon.
      icon: iconBlob ?? (removeIcon ? null : undefined),
    },
    own?.value,
  );
  const rkey = own ? rkeyFromUri(own.uri) : generateTid();
  if (!rkey) return backToSettings("save_failed:bad_rkey");

  const res = await rpc.post(
    own ? "com.atproto.repo.putRecord" : "com.atproto.repo.createRecord",
    {
      input: {
        repo: did,
        collection: "site.standard.publication",
        rkey,
        record,
      },
    },
  );
  if (!res.ok) {
    console.error("publication save failed", res.status, res.data);
    return backToSettings(`save_failed:${res.data.error}`);
  }
  return backToSettings();
}

/**
 * The writer's four colours → `basicTheme` on their publication record.
 *
 * No second write path and no new collection: `site.standard.publication`
 * EMBEDS `site.standard.theme.basic` (see the lexicon reading in ~/lib/theme),
 * so saving a theme is a publication putRecord that leaves every other field —
 * including fields other apps wrote — exactly as it found them.
 *
 * The colours arrive as four `#rrggbb` strings and are parsed here, at the
 * write door: nothing reaches a record that is not four integers in 0–255.
 * `reset=1` is "use the defaults", which removes the field rather than storing
 * our palette in the writer's repo.
 */
async function saveTheme({
  rpc,
  form,
  did,
  pds,
  origins,
}: WriteContext): Promise<Response> {
  if (!pds) return backToSettings("save_failed:pds_unresolved");

  const reset = form.get("reset") === "1";
  const theme = reset ? null : parseThemeForm((field) => form.get(field));
  // All four or nothing — a half-applied palette is how a page ends up
  // unreadable, so a malformed submit changes nothing at all.
  if (!reset && !theme) return backToSettings("theme_invalid");

  // A theme has nowhere to live without a publication, and creating one here
  // would invent a name and a URL the writer never chose.
  const own = await findOwnPublication(pds, did, origins);
  if (!own) return backToSettings("theme_no_publication");
  const rkey = rkeyFromUri(own.uri);
  if (!rkey) return backToSettings("save_failed:bad_rkey");

  let record: ReturnType<typeof withBasicTheme>;
  try {
    record = withBasicTheme(own.value, theme);
  } catch (err) {
    console.warn("theme merge refused", err);
    return backToSettings("save_failed:invalid_record");
  }

  const res = await rpc.post("com.atproto.repo.putRecord", {
    input: {
      repo: did,
      collection: "site.standard.publication",
      rkey,
      record,
    },
  });
  if (!res.ok) {
    console.error("theme save failed", res.status, res.data);
    return backToSettings(`save_failed:${res.data.error}`);
  }
  return backToSettings();
}

/**
 * One-click move of a legacy-origin publication to the canonical origin:
 * putRecord rewriting `url` ONLY (name, description, theme, everything else
 * preserved). Offered on /settings and /dashboard when publication.url still
 * points at a legacy origin (goldroad.kibuchi.workers.dev). Documents need no
 * rewrite — they reference the publication by at:// URI and compose their
 * canonical URLs from its (now canonical) `url`.
 */
async function migratePublication({
  rpc,
  form,
  did,
  ident,
  pds,
  origins,
}: WriteContext): Promise<Response> {
  const back = (query: Record<string, string>) =>
    form.get("returnTo") === "settings"
      ? redirectTo(`/settings?${new URLSearchParams(query)}`)
      : backToDashboard(query);

  if (!pds) return back({ error: "move_failed:pds_unresolved" });
  const own = await findOwnPublication(pds, did, origins);
  if (!own) return back({ error: "move_no_publication" });
  // Already canonical (e.g. double-submit): nothing to write, report success.
  if (!isOwnPublicationUrl(own.value.url, LEGACY_ORIGINS)) {
    return back({ moved: "1" });
  }
  const rkey = rkeyFromUri(own.uri);
  if (!rkey) return back({ error: "move_failed:bad_rkey" });

  const res = await rpc.post("com.atproto.repo.putRecord", {
    input: {
      repo: did,
      collection: "site.standard.publication",
      rkey,
      record: {
        ...own.value,
        $type: "site.standard.publication",
        url: `${CANONICAL_ORIGIN}/@${ident}`,
      },
    },
  });
  if (!res.ok) {
    console.error("publication move failed", res.status, res.data);
    return back({ error: `move_failed:${res.data.error}` });
  }
  return back({ moved: "1" });
}
