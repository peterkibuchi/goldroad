/**
 * The document body's markdown, as an `at.markpub.markdown` entry in
 * `site.standard.document`'s open `content` union, and the single place
 * anything reads a document's body out of a record.
 *
 * `textContent` is specified as plaintext ("Should not contain markdown or
 * other formatting"), so the formatted body goes in `content`, which the
 * lexicon leaves open for exactly this. We use markpub's shared type
 * (https://markpub.at) rather than one of our own so that other apps that read
 * markdown documents read ours, and we read theirs. `textContent` stays the
 * plaintext projection for every reader that knows neither.
 *
 * A PDS accepts the entry: `content` is an open union with no refs, and a PDS
 * holds no schema for `site.standard.*` to validate against. Passing
 * `validate: true` on write would make that a hard error, so nothing does.
 */

export const MARKDOWN_CONTENT_TYPE = "at.markpub.markdown";

/** What we write: the body as GitHub-Flavored Markdown, inline in the record.
 * Field layout follows the `at.markpub.markdown` and `at.markpub.text`
 * lexicons; `text.markdown` is the only required field. */
export type MarkdownContent = {
  $type: typeof MARKDOWN_CONTENT_TYPE;
  text: { $type: "at.markpub.text"; markdown: string };
  flavor: "gfm";
};

export function markdownContent(markdown: string): MarkdownContent {
  return {
    $type: MARKDOWN_CONTENT_TYPE,
    text: { $type: "at.markpub.text", markdown },
    flavor: "gfm",
  };
}

/** The inline markdown of a markpub entry, or null when `content` isn't one.
 * Records arrive from arbitrary PDSes, so the payload is checked, not just the
 * `$type`. */
function markpubText(
  content: unknown,
): { markdown: string; textBlob?: unknown } | null {
  if (typeof content !== "object" || content === null) return null;
  const { $type, text } = content as { $type?: unknown; text?: unknown };
  if ($type !== MARKDOWN_CONTENT_TYPE) return null;
  if (typeof text !== "object" || text === null) return null;
  const { markdown, textBlob } = text as {
    markdown?: unknown;
    textBlob?: unknown;
  };
  return typeof markdown === "string" ? { markdown, textBlob } : null;
}

/**
 * Whether a document is off-limits to our editor: any `content` we can't
 * round-trip. That covers other formats (Leaflet's `pub.leaflet.content`), a
 * malformed markpub entry, and a markpub entry whose body lives in `textBlob`,
 * where `text.markdown` is only a preview. Saving over any of these would
 * replace a body we never read.
 */
export function hasForeignContent(doc: { content?: unknown }): boolean {
  if (doc.content == null) return false;
  const text = markpubText(doc.content);
  return text === null || text.textBlob != null;
}

/**
 * A document's body as markdown, for any author's record: markpub's inline
 * markdown when present, else `textContent`. That fallback covers records
 * without a union (older ones keep markdown in `textContent`) and other
 * formats, whose `textContent` is plaintext and renders as such.
 *
 * A markpub `textBlob` is not fetched; its required inline `markdown` (the
 * preview) is what renders.
 */
export function documentBodyMarkdown(doc: {
  content?: unknown;
  textContent?: unknown;
}): string {
  const text = markpubText(doc.content);
  if (text) return text.markdown;
  return typeof doc.textContent === "string" ? doc.textContent : "";
}
