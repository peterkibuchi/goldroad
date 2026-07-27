/**
 * "Announce on Bluesky" record shaping — an app.bsky.feed.post in the
 * writer's own repo. Never called without an explicit user action.
 *
 * Two mechanisms ride in one post, both verified against live records
 * (2026-07-23, see PR):
 *
 * 1. text = title + "\n" + canonical URL, with a link facet over the URL.
 *    Facet indices are UTF-8 BYTE offsets, not JS string (UTF-16 code unit)
 *    offsets — an emoji in the title shifts them apart. (app.bsky.richtext.facet
 *    lexicon: "byteSlice"). A facet alone does NOT produce a link card.
 * 2. embed = app.bsky.embed.external with `associatedRefs` strongRefs to the
 *    site.standard.document (and its publication). This is what makes Bluesky
 *    render the enriched standard.site reader card
 *    (github.com/bluesky-social/atproto discussion #4978; Leaflet's own
 *    announce posts, e.g. at://did:plc:ukp7pzzht32uigg6bg4vxr5t/
 *    app.bsky.feed.post/3lyk74buirc2f, carry the same embed shape).
 *
 * Shapes are hand-rolled minimally rather than pulling in @atcute/bluesky:
 * `associatedRefs` is newer than the published lexicon types anyway (unknown
 * object fields are legal in the atproto data model).
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
