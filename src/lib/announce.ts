/**
 * Announcing a post on Bluesky: the app.bsky.feed.post that goes into the
 * writer's own repo, the ONE function that writes it, and the policy deciding
 * whether a publish gets to write one unattended.
 *
 * ANNOUNCING IS NOW THE DEFAULT, which is a change of kind and not of degree.
 * This module used to say "never called without an explicit user action", and
 * that sentence was the whole safety story: a human pressed a button, saw the
 * result, and pressed it again if it went wrong. Publishing now announces on the
 * writer's behalf — from a form they submitted, and from a cron at 09:00 with
 * nobody watching — so the safety has to live in code instead of in the
 * writer's attention. Three rules carry it, and they are the reason this file
 * holds the policy rather than each caller holding a copy:
 *
 *  1. ONE POST PER DOCUMENT, unless a human says otherwise. The document's
 *     `bskyPostRef` is the record of having announced; `createAnnouncement`
 *     refuses when it is already set, and only the dashboard's confirmed
 *     "Announce again" is allowed to override that. The OAuth scope we hold is
 *     create-only (~/lib/oauth-scopes) — we cannot delete a duplicate we make,
 *     and neither can the writer without leaving the app.
 *  2. THE AUTO PATH FIRES ON A FIRST PUBLISH AND NOWHERE ELSE. Not on an edit,
 *     not on a republish, not on a bulk anything (`NEVER_ANNOUNCE`). See
 *     `autoAnnounceSkip` for what else it refuses and why.
 *  3. THE DOCUMENT IS COMMITTED FIRST, ALWAYS. A failed announce is reported;
 *     it never fails, retries, or rolls back the publish it followed.
 *
 * Two mechanisms ride in one post, both re-verified 2026-08-17:
 *
 * 1. text = title + "\n" + canonical URL, with a link facet over the URL.
 *    Facet indices are UTF-8 BYTE offsets, not JS string (UTF-16 code unit)
 *    offsets — an emoji in the title shifts them apart. (app.bsky.richtext.facet
 *    lexicon: "byteSlice"). A facet alone does NOT produce a link card.
 * 2. embed = app.bsky.embed.external with `associatedRefs` strongRefs to the
 *    site.standard.document (and its publication). This is what makes Bluesky
 *    render the enriched standard.site reader card.
 *
 *    `associatedRefs` is no longer an undocumented field: it is IN the published
 *    lexicon (lexicons/app/bsky/embed/external.json on bluesky-social/atproto,
 *    `external.associatedRefs`, an array of com.atproto.repo.strongRef,
 *    described as "StrongRefs (uri+cid) of the Atmosphere records that backed
 *    this view"). Live confirmation too: 41 of 62 external-embed posts across
 *    Leaflet's own accounts carry it, e.g.
 *    at://did:plc:ukp7pzzht32uigg6bg4vxr5t/app.bsky.feed.post/3mrpug772jk2c.
 *    The record cited here previously (…/3lyk74buirc2f) no longer carries the
 *    field and is not evidence of anything — a dated citation to a mutable
 *    record is worth re-checking before it is trusted.
 *
 * Shapes are still hand-rolled minimally rather than pulling in @atcute/bluesky:
 * one optional field in one embed does not justify the dependency.
 */

/** app.bsky.feed.post text limit (graphemes). The byte limit (3000) can't be
 * hit first at ≤300 graphemes of any UTF-8 (max 4 bytes each + ZWJ sequences
 * count as one grapheme but stay far under 10 bytes/grapheme on real titles). */
const MAX_POST_GRAPHEMES = 300;

const utf8 = new TextEncoder();

/** UTF-8 byte length of a JS string — facet offsets count these, not chars. */
export function utf8Length(s: string): number {
  return utf8.encode(s).length;
}

/** First `max` graphemes of `s` (never splits an emoji/combining sequence),
 * with a single-char ellipsis when truncated. */
export function truncateGraphemes(s: string, max: number): string {
  if (max <= 0) return "";
  const segments = [...new Intl.Segmenter().segment(s)];
  if (segments.length <= max) return s;
  return `${segments
    .slice(0, max - 1)
    .map((seg) => seg.segment)
    .join("")}…`;
}

// Registers com.atproto.* XRPC procedure types (typed createRecord/putRecord).
import type {} from "@atcute/atproto";
import type { Client } from "@atcute/client";

import { type Did, isInsufficientScope, rkeyFromUri } from "~/lib/atproto";
import type { BlobObject } from "~/lib/blob";

export type AssociatedRef = { uri: string; cid: string };

export type AnnouncePostInput = {
  title: string;
  /** Canonical composed document URL — also the external embed target. */
  url: string;
  /** Card description (document.description); empty string is lexicon-legal. */
  description?: string;
  /** strongRefs to the standard.site records backing the URL (document first). */
  associatedRefs?: AssociatedRef[];
  /**
   * Card thumbnail — app.bsky.embed.external#thumb (blob, image/*, maxSize
   * 1,000,000; verified against the app.bsky lexicon 2026-07-24). We reuse
   * the document's coverImage blob: it already lives in the writer's repo,
   * and this second record reference independently keeps it alive. Callers
   * must pre-check the 1MB cap — the PDS validates thumb constraints on
   * write, and an oversized thumb would fail the whole announce.
   */
  thumb?: BlobObject;
  createdAt?: Date;
};

export type AnnouncePost = {
  $type: "app.bsky.feed.post";
  text: string;
  facets: Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string }>;
  }>;
  embed: {
    $type: "app.bsky.embed.external";
    external: {
      uri: string;
      title: string;
      description: string;
      thumb?: BlobObject;
      associatedRefs?: AssociatedRef[];
    };
  };
  createdAt: string;
};

/** Builds the announce post. The title is grapheme-truncated so the full URL
 * always survives intact (a truncated URL breaks both facet and tap target). */
export function buildAnnouncePost(input: AnnouncePostInput): AnnouncePost {
  const url = input.url.trim();
  const urlGraphemes = [...new Intl.Segmenter().segment(url)].length;
  const title = truncateGraphemes(
    input.title.trim(),
    MAX_POST_GRAPHEMES - urlGraphemes - 1, // -1 for the separating newline
  );

  const text = title ? `${title}\n${url}` : url;
  const byteStart = utf8Length(text) - utf8Length(url);
  const byteEnd = byteStart + utf8Length(url);

  const external: AnnouncePost["embed"]["external"] = {
    uri: url,
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
  };
  if (input.thumb) external.thumb = input.thumb;
  if (input.associatedRefs && input.associatedRefs.length > 0) {
    external.associatedRefs = input.associatedRefs;
  }

  return {
    $type: "app.bsky.feed.post",
    text,
    facets: [
      {
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
      },
    ],
    embed: { $type: "app.bsky.embed.external", external },
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Policy: may this publish announce itself?
// ---------------------------------------------------------------------------

/**
 * Auto announces one writer may spend in a rolling hour.
 *
 * A BACKSTOP, NOT A PRODUCT RULE. Nothing a writer does by hand is counted, and
 * no path we ship today can reach five in an hour: the archive importer is on
 * the skip list, and the cron publishes at most MAX_PUBLISHES_PER_TICK posts a
 * tick (~/lib/scheduled-posts), which this number matches on purpose — one tick
 * can never overrun a timeline even if every post in it belonged to one writer.
 * What it really guards is the path nobody has written yet. The cost of it
 * biting a real writer is that their fifth post of the hour publishes with an
 * "Announce" button instead of an announcement, which they can press.
 */
export const MAX_AUTO_ANNOUNCES_PER_HOUR = 5;

export const AUTO_ANNOUNCE_WINDOW_MS = 60 * 60 * 1000;

/**
 * How stale a `publishedAt` may be before the auto path treats the post as
 * archive material and stays quiet.
 *
 * A day, because a post published now carries a `publishedAt` of now — the only
 * way to be a day out is to have been backdated on purpose, which is exactly
 * what importing an archive does (see `clampOriginalDate` in ~/lib/import). It
 * is a second guard on the same case the import ledger already catches, and it
 * is here because the ledger read is best-effort: a writer bringing forty posts
 * across must never have forty of them land in their followers' timelines
 * because one D1 read flaked.
 */
export const AUTO_ANNOUNCE_MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;

/** Why an auto announce did not happen. Every value is a sentence away from
 * something a writer or an operator can read; none of them is a failure. */
export type AutoAnnounceSkip =
  | "not_requested"
  | "imported"
  | "backdated"
  | "taken_down"
  | "over_budget";

/**
 * The decision to announce, as it travels with a publish.
 *
 * It is a REQUIRED argument on every publish entry point, and that is the
 * enforcement rather than the documentation: a future bulk path cannot forget to
 * think about announcing, because the code will not compile until it says what
 * it wants. `NEVER_ANNOUNCE` is the answer any such caller should pass.
 *
 * `source` is for the log line only. It is what tells an operator reading
 * "auto announce skipped: imported" whether the decision came from a form a
 * writer submitted or from a schedule row filled in last Tuesday.
 */
export type AnnounceIntent = {
  requested: boolean;
  source: "publish" | "schedule" | "publish-now" | "bulk";
};

/**
 * The constant every bulk or migration caller passes. A path that publishes
 * many posts at once must not announce any of them — forty cards in a timeline
 * is not distribution, it is the thing that makes somebody mute you — and the
 * writer can announce the ones they want from their posts page.
 */
export const NEVER_ANNOUNCE: AnnounceIntent = {
  requested: false,
  source: "bulk",
};

/**
 * Should this publish announce itself? Returns the reason it should NOT, or
 * null to go ahead. Pure: the budget is checked separately because spending a
 * slot is a write (see `consumeAutoAnnounceBudget` in ~/lib/announce-prefs),
 * and `over_budget` is in the vocabulary here so that one log line and one set
 * of reasons covers every way a publish can stay quiet.
 *
 * `hidden` is the takedown list (~/lib/moderation). /api/publish had no reason
 * to consult it before this: writing a record is the writer's business, and a
 * document nobody may serve is still their record. Amplifying it is OUR act, on
 * OUR say-so, into somebody else's timeline — so this is the one publish-time
 * decision the takedown list gets a vote on.
 */
export function autoAnnounceSkip(input: {
  /** The captured decision — the per-post toggle, not the account setting. */
  requested: boolean;
  /** This draft came from an import: its ledger row exists. */
  imported: boolean;
  /** The writer or this document is on the takedown list. */
  hidden: boolean;
  /** The record's own publishedAt, when it was backdated. */
  publishedAt?: Date | null;
  now: number;
}): AutoAnnounceSkip | null {
  if (!input.requested) return "not_requested";
  if (input.imported) return "imported";
  if (input.hidden) return "taken_down";
  const published = input.publishedAt?.getTime();
  if (
    typeof published === "number" &&
    Number.isFinite(published) &&
    input.now - published > AUTO_ANNOUNCE_MAX_BACKDATE_MS
  )
    return "backdated";
  return null;
}

// ---------------------------------------------------------------------------
// The one write path.
// ---------------------------------------------------------------------------

/** What an announce attempt reports. `wroteBack` false means the post is live
 * but the document does not say so — see the residual note on
 * `createAnnouncement`. */
export type AnnounceResult =
  | {
      ok: true;
      postUri: string;
      postRkey: string | null;
      wroteBack: boolean;
    }
  | {
      ok: false;
      /** `already_announced` is a refusal, not a failure: the post exists. */
      reason: "already_announced" | "scope" | "refused";
      /** The PDS's own error name, when it had one. */
      detail?: string;
    };

/** A document already carries a Bluesky post reference. Untrusted shape (any
 * app may have written the field), so "is there something here at all" is the
 * only question asked — an unparseable ref still means somebody announced. */
export function hasAnnouncement(record: { bskyPostRef?: unknown }): boolean {
  const ref = record.bskyPostRef;
  return ref !== null && ref !== undefined && ref !== "";
}

/**
 * Creates the announce post and records it on the document. THE ONLY PLACE
 * app.bsky.feed.post is written — the manual button, the interactive publish and
 * the cron all come through here, so the idempotency rule below has one home.
 *
 * TWO WRITES, IN THIS ORDER, and the order is forced: the strongRef written
 * back into `bskyPostRef` is only knowable after the create. The write-back is
 * best-effort by necessity — the post is already public, and a second create to
 * "fix" the bookkeeping would put a second card in the timeline.
 *
 * THE RESIDUAL, STATED HONESTLY. If the create succeeds and the write-back
 * fails, the document does not carry the ref, so nothing downstream knows the
 * post was announced: the dashboard offers "Announce" rather than "Announce
 * again", and pressing it makes a second post. That is not closed, and it is not
 * closable cheaply — "is there already an announcement for this URL" is not a
 * query the protocol offers, and answering it means listing the writer's whole
 * app.bsky.feed.post collection and reading every embed, which for anyone
 * active on Bluesky is thousands of records per publish. What IS closed is the
 * unattended half: the auto path only ever fires on a first publish, so a lost
 * write-back can never produce a duplicate without a human pressing a confirmed
 * button. The blast radius is one post, made deliberately, by the person whose
 * timeline it lands in.
 */
export async function createAnnouncement(input: {
  rpc: Client;
  did: Did;
  /** The document's record key — where the ref is written back. */
  rkey: string;
  post: AnnouncePost;
  /** The document as it stands now: the record to merge the ref into, and the
   * CID to pin that merge against. */
  document: { record: Record<string, unknown>; cid?: string };
  /** Announce even though the document already carries a ref. ONLY a confirmed
   * "Announce again" sets this — see the idempotency rule above. */
  force?: boolean;
}): Promise<AnnounceResult> {
  const { rpc, did, rkey, post, document, force } = input;
  if (!force && hasAnnouncement(document.record))
    return { ok: false, reason: "already_announced" };

  const res = await rpc.post("com.atproto.repo.createRecord", {
    // No rkey: the PDS mints the post's key, as Bluesky's own clients do.
    input: { repo: did, collection: "app.bsky.feed.post", record: post },
  });
  // @atcute/client does not throw on XRPC errors — check ok explicitly.
  if (!res.ok) {
    if (isInsufficientScope(res)) return { ok: false, reason: "scope" };
    console.error("announce createRecord failed", res.status, res.data);
    return {
      ok: false,
      reason: "refused",
      detail: typeof res.data.error === "string" ? res.data.error : undefined,
    };
  }

  // The lexicon-native slot, so the state travels with the record and any app
  // can read it. This is NOT an edit of the document's content — every field,
  // including a foreign `content` union, is preserved — so the not_editable
  // rule doesn't apply.
  //
  // swapRecord pins the version we read: a concurrent edit wins and we never
  // clobber. It requires a CID; without one the put would be unconditional,
  // which is the single way this could stomp somebody's edit, so the write-back
  // is skipped instead.
  let wroteBack = false;
  if (res.data.uri && res.data.cid && document.cid) {
    const writeBack = await rpc
      .post("com.atproto.repo.putRecord", {
        input: {
          repo: did,
          collection: "site.standard.document",
          rkey,
          record: {
            ...document.record,
            $type: "site.standard.document",
            bskyPostRef: { uri: res.data.uri, cid: res.data.cid },
          },
          swapRecord: document.cid,
        },
      })
      .catch(() => null);
    wroteBack = writeBack?.ok === true;
    if (!wroteBack)
      // Loud, not a shrug: this is the state that makes a duplicate possible
      // later, and the only record of it is this line.
      console.error(
        "announce recorded a post the document does not reference",
        rkey,
        res.data.uri,
        writeBack?.data,
      );
  } else if (!document.cid) {
    console.warn("announce write-back skipped: no CID to pin", rkey);
  }

  return {
    ok: true,
    postUri: res.data.uri,
    postRkey: rkeyFromUri(res.data.uri),
    wroteBack,
  };
}
