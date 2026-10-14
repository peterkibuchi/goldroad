/**
 * Announcing a published document on Bluesky: an app.bsky.feed.post in the
 * writer's repo, carrying the card that links back to the post (see
 * ~/lib/announce), then the post's strongRef written into the document's
 * `bskyPostRef`. Shared by the dashboard's "Announce on Bluesky" button, the
 * publish form's "Also announce on Bluesky" box, and the cron publishing a
 * scheduled post that asked for it.
 *
 * Costs four subrequests: the document and its publication read from the PDS,
 * the post, and the write-back.
 */
import type { Client } from "@atcute/client";

import { type AssociatedRef, buildAnnouncePost } from "~/lib/announce";
import {
  type Did,
  getRecordEntry,
  parseAtUri,
  rkeyFromUri,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { thumbFromCover } from "~/lib/blob";
import { composeDocumentUrl } from "~/lib/publish";

export type AnnounceOutcome =
  | { ok: true; postRkey: string | null }
  | {
      ok: false;
      /** Dashboard error code (see ERROR_MESSAGES in ~/routes/dashboard). */
      code: string;
    };

/**
 * Announces the document at `rkey`. With `onlyOnce`, a document that already
 * carries a `bskyPostRef` is refused: an automatic announce must never post
 * twice, even when a retried publish finds its record already live. The
 * dashboard's button doesn't set it; re-announcing there is deliberate and
 * confirmed.
 */
export async function announceDocument(input: {
  rpc: Client;
  did: Did;
  ident: string;
  pds: string;
  origin: string;
  rkey: string;
  onlyOnce?: boolean;
}): Promise<AnnounceOutcome> {
  const { rpc, did, ident, pds, origin, rkey } = input;
  let doc: Awaited<ReturnType<typeof getRecordEntry<StandardDocument>>>;
  try {
    doc = await getRecordEntry<StandardDocument>(
      pds,
      did,
      "site.standard.document",
      rkey,
    );
  } catch {
    return { ok: false, code: "not_found" };
  }
  if (input.onlyOnce && doc.value.bskyPostRef)
    return { ok: false, code: "already_announced" };

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
    if (res.status === 401 || res.status === 403)
      return { ok: false, code: "announce_scope" };
    console.error("announce createRecord failed", res.status, res.data);
    return { ok: false, code: `announce_failed:${res.data.error}` };
  }

  // Write the post's strongRef into the document's lexicon-native
  // `bskyPostRef`, so the dashboard shows "Announced" and the state travels
  // with the record. Not an edit of the content: every field, a foreign
  // `content` union included, is preserved. swapRecord pins the version we
  // read, so a concurrent edit wins; without doc.cid the put would be
  // unconditional, so it's skipped. Best-effort: the announce already
  // happened, and a failed write-back only costs status honesty.
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
  return { ok: true, postRkey: rkeyFromUri(res.data.uri) };
}
