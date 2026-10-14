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

type MarkpubEntry = {
  text: { markdown: string; textBlob?: unknown; [key: string]: unknown };
  [key: string]: unknown;
};

/** `content` as a markpub entry, or null when it isn't one. Records arrive
 * from arbitrary PDSes, so the payload is checked, not just the `$type`. */
function markpubEntry(content: unknown): MarkpubEntry | null {
  if (typeof content !== "object" || content === null) return null;
  const entry = content as { $type?: unknown; text?: unknown };
  if (entry.$type !== MARKDOWN_CONTENT_TYPE) return null;
  const text = entry.text as { markdown?: unknown } | null | undefined;
  if (typeof text !== "object" || text === null) return null;
  return typeof text.markdown === "string" ? (entry as MarkpubEntry) : null;
}

/** Optional markpub fields an edit here would drop or invalidate: front
 * matter, renderer extensions, and facets/lenses indexed into the old text. */
const UNKEPT_FIELDS = ["frontMatter", "extensions"] as const;
const UNKEPT_TEXT_FIELDS = ["facets", "lenses"] as const;

const hasItems = (value: unknown) => Array.isArray(value) && value.length > 0;

/**
 * Whether a document is off-limits to our editor: any `content` we can't
 * round-trip. That covers other formats (Leaflet's `pub.leaflet.content`), a
 * malformed markpub entry, one whose body lives in `textBlob` (the inline
 * markdown is then only a preview), and one carrying fields an edit would
 * drop. Saving over any of these would replace what we never read.
 */
export function hasForeignContent(doc: { content?: unknown }): boolean {
  if (doc.content == null) return false;
  const entry = markpubEntry(doc.content);
  if (!entry || entry.text.textBlob != null) return true;
  return (
    UNKEPT_FIELDS.some((key) => hasItems(entry[key])) ||
    UNKEPT_TEXT_FIELDS.some((key) => hasItems(entry.text[key]))
  );
}

/**
 * A document's body as markdown, for any author's record: markpub's inline
 * markdown when present, else `textContent`. That fallback covers records
 * without a union (older ones keep markdown in `textContent`) and other
 * formats, whose `textContent` is plaintext and renders as such.
 *
 * A markpub `textBlob` is not fetched. Its inline markdown is only a preview,
 * so the full plaintext in `textContent` wins when there is one.
 */
export function documentBodyMarkdown(doc: {
  content?: unknown;
  textContent?: unknown;
}): string {
  const entry = markpubEntry(doc.content);
  const textContent =
    typeof doc.textContent === "string" ? doc.textContent : "";
  if (!entry) return textContent;
  if (entry.text.textBlob != null && textContent.trim()) return textContent;
  return entry.text.markdown;
}
