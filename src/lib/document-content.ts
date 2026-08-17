/**
 * Our one extension lexicon — `pub.goldroad.content.markdown` — and the single
 * place anything reads a document's body out of a record.
 *
 * Why it exists. The standard lexicon's own words for `textContent` are
 * "Plaintext representation of the documents contents. Should not contain
 * markdown or other formatting." We stored markdown in it anyway, because it
 * was the only field on the record that could hold a body at all. Two costs
 * followed: every other app in the network rendered our posts with the
 * `**asterisks**` showing, and our own editor round-trip depended on a field
 * the lexicon promises carries no formatting. `content` is an open union
 * declared for exactly this — "may be extended with other lexicons to support
 * additional content formats" — so the format goes there, and `textContent`
 * goes back to being the plaintext projection it was always specified to be.
 *
 * `site.standard.*` stays the primary surface. The union supplements it and
 * nothing depends on a reader understanding it: anything that doesn't falls
 * back to `textContent` and still gets the whole piece, just flat.
 *
 * The NSID is permanent, unrenameable public API (see the schema in
 * `lexicons/`). Its authority is `content.goldroad.pub` — the domain segments
 * reversed, minus the final name segment, the same shape as `app.bsky.feed.post`
 * resolving to `feed.bsky.app`. Lexicon resolution is not hierarchical, so if
 * these schemas are ever served over the network it is from
 * `_lexicon.content.goldroad.pub` and not from the bare domain.
 *
 * Will a PDS accept a `$type` it has no schema for? Yes, and the reasoning is
 * worth keeping because it is not obvious:
 *
 * - The published `site.standard.document` schema declares `content` as a union
 *   with an EMPTY `refs` list and `closed: false`. There is no ref set our
 *   `$type` could fall outside of; an unrecognised entry in an open union is
 *   passed through on a stringness check alone, with no attempt to resolve it.
 * - More bluntly: a PDS validates only record types it holds a schema for, and
 *   `site.standard.*` is not among them. That is already load-bearing — every
 *   document we have ever published relies on it — so a field inside such a
 *   record cannot be enforced either. The protocol calls this fail-open.
 *
 * The one way to break that: passing `validate: true` to createRecord/putRecord
 * makes an unknown record type a hard error. Nothing here sends it. Don't.
 */

/** The `$type` of our content-union entry. Permanent — see the file header. */
export const MARKDOWN_CONTENT_TYPE = "pub.goldroad.content.markdown";

/** An entry in `site.standard.document`'s open `content` union: the body as
 * GitHub-Flavored CommonMark. The only shape we ever write into that field. */
export type MarkdownContent = {
  $type: typeof MARKDOWN_CONTENT_TYPE;
  markdown: string;
};

export function markdownContent(markdown: string): MarkdownContent {
  return { $type: MARKDOWN_CONTENT_TYPE, markdown };
}

/**
 * Whether a `content` value is ours. Records arrive from arbitrary PDSes, so
 * this validates the payload and not just the `$type`: a record claiming our
 * type with no `markdown` string is not something we can render or edit, and
 * treating it as ours would mean publishing an edit that silently dropped a
 * body we never actually read.
 */
export function isMarkdownContent(
  content: unknown,
): content is MarkdownContent {
  if (typeof content !== "object" || content === null) return false;
  const value = content as { $type?: unknown; markdown?: unknown };
  return (
    value.$type === MARKDOWN_CONTENT_TYPE && typeof value.markdown === "string"
  );
}

/**
 * A content union that isn't ours — Leaflet's `pub.leaflet.content`, a format
 * that doesn't exist yet, or a malformed claim on our own type.
 *
 * These documents stay read-only here. Their rich content is the source of
 * truth in the app that owns the format, so saving our body over the record
 * would leave readers on the stale rich content while the writer believed the
 * edit had landed. That refusal is the ONLY thing this predicate is for — a
 * document carrying *our* union is ours to edit, with the markdown intact.
 */
export function hasForeignContent(doc: { content?: unknown }): boolean {
  return doc.content != null && !isMarkdownContent(doc.content);
}

/**
 * A document's body as markdown, for any generation of record. Three cases,
 * and the reason this is one function rather than a check at each call site:
 *
 * - **Post-mint records of ours** carry the union; its markdown is the source
 *   of truth and `textContent` is a lossy projection of it.
 * - **Pre-mint records** (ours, and plain `site.standard.document` records
 *   from apps that also put markdown there) carry no union, and their
 *   `textContent` is markdown-shaped. Returning it unchanged is what keeps
 *   every already-published post rendering exactly as it does today. These are
 *   deliberately NOT migrated in bulk: they gain the union the next time the
 *   writer saves, and cost nothing until then.
 * - **Foreign-union records** fall back to `textContent` as well. For them it
 *   really is plaintext — and plaintext through the markdown renderer is
 *   already what those documents get today, unchanged by any of this.
 */
export function documentBodyMarkdown(doc: {
  content?: unknown;
  textContent?: unknown;
}): string {
  if (isMarkdownContent(doc.content)) return doc.content.markdown;
  return typeof doc.textContent === "string" ? doc.textContent : "";
}
