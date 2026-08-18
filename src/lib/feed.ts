/**
 * RSS 2.0 assembly for the per-publication feeds — pure string building, no
 * bindings, so it unit-tests directly.
 *
 * Threat model: every interpolated value is third-party-authored (record
 * fields read from arbitrary PDSes) flowing into an XML document — treat as
 * hostile. `escapeXml` is the single choke point: all values, element text and
 * attribute alike, pass through it. No CDATA sections anywhere (escaping `>`
 * makes `]]>` inert; CDATA would reopen that door).
 */

export const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Characters outside the XML 1.0 Char production: C0 controls minus
 * tab/LF/CR, DEL + C1, and the U+FFFE/U+FFFF noncharacters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping XML-illegal control chars is the point
const XML_ILLEGAL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffe\uffff]/g;

/** Lone surrogate halves — legal in JS strings, fatal when serialized. */
const LONE_SURROGATE_RE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Escapes a string for interpolation into XML element text or attribute
 * values. All five metacharacters are escaped unconditionally (covers `]]>`
 * and attribute breakouts), XML-illegal characters are dropped, and lone
 * surrogates become U+FFFD. Emoji and other astral-plane pairs pass through
 * untouched.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/[&<>"']/g, (c) => XML_ENTITIES[c])
    .replace(XML_ILLEGAL_RE, "")
    .replace(LONE_SURROGATE_RE, "\ufffd");
}

/** Hard bound on the default markdown-stripping scan window. Feed
 * `textContent` arrives from arbitrary PDSes with NO size cap, and the regex
 * passes in stripMarkdown must never run over megabytes (the Workers CPU
 * budget is ~10 ms/invocation, and a feed strips up to 50 records). 2 KB of
 * source comfortably yields a ~300-char excerpt even after heavy markup
 * stripping. */
const EXCERPT_SCAN_CHARS = 2048;

/**
 * Best-effort markdown-to-plain-text strip: removes the common markdown
 * constructs, collapses whitespace, trims. Lossy by design. Shared by the
 * feed excerpts here and the document description excerpt in ~/lib/publish —
 * it is the ONLY markdown strip in the codebase; don't fork it (the
 * pre-hardening copies went quadratic on hostile input).
 *
 * Hardening, in two layers:
 * - `scanChars` bounds the window the regexes run over. The default suits
 *   unbounded third-party input; callers whose input is already
 *   length-validated may pass their validated bound instead.
 * - The image/link patterns exclude `[` from the text class and `(`/`)` from
 *   the URL class, so a stray bracket fails at the next bracket instead of
 *   scanning to the end of the input — hostile bracket floods stay linear
 *   instead of going quadratic, whatever the window.
 */
export function stripMarkdown(
  text: string,
  scanChars = EXCERPT_SCAN_CHARS,
): string {
  return stripMarkdownConstructs(text, scanChars, "drop-url")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What becomes of a link's destination.
 *
 * `drop-url` for the excerpt: a URL inside a 300-character card description is
 * noise, and the description sits beside a link to the post anyway.
 *
 * `keep-url` for the whole-document projection: `textContent` is the post as
 * every reader outside Goldroad sees it, and a link whose destination has been
 * deleted is not a lossy rendition of that post — it is a wrong one. The
 * reader is left with underlined-looking words pointing nowhere and no way to
 * find where they pointed.
 */
type LinkMode = "drop-url" | "keep-url";

/** One link as plain text. Handles both destination spellings markdown allows
 * — a bare URL with an optional `"title"`, and the angle-bracket form — and
 * says nothing twice when the text already IS the URL. */
function linkAsText(text: string, destination: string, mode: LinkMode): string {
  const label = text.trim();
  if (mode === "drop-url") return label;
  const raw = destination.trim();
  // `<…>` is the spelling that exists precisely so a URL may contain spaces,
  // so the whitespace split below must not be applied to it.
  const angled = /^<([^>]*)>/.exec(raw);
  const url = angled ? angled[1] : (raw.split(/\s+/)[0] ?? "");
  if (!url) return label;
  if (!label || label === url) return url;
  return `${label} (${url})`;
}

/** A GFM table's delimiter row (`|---|:--:|`): pipes, dashes, colons and
 * spaces, and nothing else. Pure punctuation — there is no reading of it that
 * belongs in plain text. */
function isTableDelimiterRow(line: string): boolean {
  return /^[\s:|-]+$/.test(line) && line.includes("|") && line.includes("-");
}

/** A setext heading underline (`====`, `----`) or a thematic break (`***`,
 * `___`, `- - -`). The heading's own words are the line above and are kept;
 * the underline is a formatting instruction with no text in it. */
const RULE_LINE_RE = /^(?:={2,}|(?:[-*_][ \t]*){2,})$/;

/** A link reference definition (`[label]: https://… "Title"`) — machinery for
 * links written elsewhere in the document, carrying no prose of its own. */
const LINK_DEFINITION_RE = /^\[[^\]^]+\]:\s*\S+(?:\s+["'(].*)?$/;

/** A footnote definition (`[^1]: the note itself`). Unlike the definition
 * above this DOES carry prose, so the marker goes and the words stay. */
const FOOTNOTE_DEFINITION_RE = /^\[\^[^[\]]*\]:\s*(.*)$/;

/** Cells of one table row, pipe grid removed. Leading/trailing pipes are
 * frame, not empty cells; an escaped `\|` is content and must not split. */
function tableRowAsText(line: string): string {
  return line
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim())
    .filter((cell) => cell !== "")
    .join(" · ");
}

/**
 * The markdown whose meaning lives in whole LINES rather than in delimiters
 * inside one — which the inline ladder below cannot see, and therefore used to
 * pass through verbatim into a field the lexicon says holds no markdown at
 * all: pipe grids, `---|---` rows, `====` underlines and reference
 * definitions, all sitting in the plaintext every non-Goldroad reader falls
 * back to.
 *
 * Line-oriented and single-pass, so it stays linear on any input.
 */
function stripBlockConstructs(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (isTableDelimiterRow(trimmed)) continue;
    if (RULE_LINE_RE.test(trimmed)) continue;
    if (LINK_DEFINITION_RE.test(trimmed)) continue;
    const footnote = FOOTNOTE_DEFINITION_RE.exec(trimmed);
    if (footnote) {
      if (footnote[1]) out.push(footnote[1]);
      continue;
    }
    // A row of a pipe table. Leading OR trailing pipe is the shape every
    // editor that emits tables produces, and prose does not start or end a
    // line with one.
    if (trimmed.includes("|") && /^\||\|$/.test(trimmed)) {
      out.push(tableRowAsText(trimmed));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The markdown-construct removal itself, with whitespace left exactly as it
 * was found. Factored out because the excerpt strip above and the full-body
 * projection below differ ONLY in how much whitespace they keep and in what
 * they do with a link's destination — which is precisely the kind of
 * near-duplicate that would otherwise get forked, and this ladder is hardened
 * against hostile input (see the note above); a fork of it would not stay
 * hardened.
 */
function stripMarkdownConstructs(
  text: string,
  scanChars: number,
  links: LinkMode,
): string {
  return (
    stripBlockConstructs(text.slice(0, scanChars))
      .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code blocks
      .replace(/`([^`]*)`/g, "$1") // inline code
      .replace(/!\[([^[\]]*)\]\([^()]*\)/g, "$1") // images → alt text
      .replace(
        /\[([^[\]]*)\]\(([^()]*)\)/g, // links → text, or "text (url)"
        (_whole, text: string, destination: string) =>
          linkAsText(text, destination, links),
      )
      .replace(/\[([^[\]]*)\]\[[^[\]]*\]/g, "$1") // reference links → link text
      // Footnote markers; their notes survive as endnote lines. `[` is excluded
      // from the label class for the same reason it is excluded from the link
      // classes above: a flood of unclosed `[^` must fail at the next bracket
      // rather than scan to the end of the document from every position.
      .replace(/\[\^[^[\]]*\]/g, "")
      .replace(/^#{1,6}\s+/gm, "") // heading markers
      .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, "") // list + task markers
      .replace(/(\*{1,3}|_{1,3}|~~)/g, "")
  ); // emphasis markers
}

/**
 * A markdown body as the plaintext that `site.standard.document` asks
 * `textContent` to hold — the lexicon's own words are "Should not contain
 * markdown or other formatting". This is the projection written into that
 * field on publish; the formatted source lives in the record's `content`
 * union (see ~/lib/document-content).
 *
 * Same hardened construct strip as the excerpt above, with two differences,
 * both because this is a whole document rather than a 300-character summary:
 *
 * - **Paragraph breaks survive.** Collapsing an article to a single line would
 *   make the field that every reader outside Goldroad falls back to unreadable.
 *   Runs of spaces collapse, blank lines cap at one, structure stays.
 * - **Fenced code survives** (its fence markers don't). An excerpt is better
 *   off skipping a code sample, but a plaintext rendition that silently omitted
 *   whole sections of a technical post would not be a rendition of that post.
 *   The code then goes through the same emphasis and list passes as prose, so
 *   code carrying markdown punctuation comes out lightly mangled — the lossless
 *   source is in the content union, which is what having one is for.
 * - **A link keeps its destination**, as `text (url)`. See LinkMode.
 *
 * LOSSY IS FINE; MANGLED IS NOT. That distinction is the whole standard this
 * function is held to, and it is what a construct-by-construct strip gets
 * wrong by omission: anything the ladder does not recognize survives verbatim,
 * so a GFM table used to be written into `textContent` as a pipe grid with a
 * `---|---` row in it — markdown, in the one field the lexicon says holds no
 * markdown, and unreadable prose besides. Tables now degrade to their cells,
 * footnote markers go while their notes stay, and reference definitions and
 * setext underlines drop out (see stripBlockConstructs).
 *
 * `scanChars` is REQUIRED here, unlike on the excerpt strip. This result is
 * stored in a record rather than rendered once, so a default window would mean
 * a caller who forgot the argument silently truncating someone's article to
 * 2 KB — permanently, in their repo. The publish path passes the same bound the
 * body was validated against, which makes the slice a no-op by construction.
 */
export function plainTextBody(markdown: string, scanChars: number): string {
  // Fence lines only. Leaves a blank line behind, which the newline collapse
  // below folds into the ordinary paragraph gap around a code block.
  const unfenced = markdown
    .slice(0, scanChars)
    .replace(/^ {0,3}(?:```|~~~)[^\n]*$/gm, "");
  return stripMarkdownConstructs(unfenced, scanChars, "keep-url")
    .replace(/[^\S\n]+/g, " ") // runs of spaces/tabs → one space
    .replace(/ ?\n ?/g, "\n") // no leading/trailing space on any line
    .replace(/\n{3,}/g, "\n\n") // at most one blank line between blocks
    .trim();
}

/**
 * Best-effort plain-text head of a markdown/plaintext body, for feed item
 * descriptions when the record carries no explicit description: the shared
 * strip above, truncated near `maxChars` on a word boundary with an
 * ellipsis. The result still goes through escapeXml at interpolation time.
 */
export function plainTextExcerpt(text: string, maxChars = 300): string {
  const plain = stripMarkdown(text);
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  // Cut at the last word boundary unless that loses too much of the budget.
  const head = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

/** RSS 2.0 pubDate (RFC 822 shape, 4-digit year, always UTC — identical on
 * every render, so cached copies never drift). Null when unparseable. */
export function rfc822Date(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toUTCString();
}

export type FeedChannel = {
  title: string;
  /** Publication page URL (the channel's human-facing home). */
  link: string;
  /** Absolute URL of this feed itself (atom:link rel="self"). */
  selfUrl: string;
  description: string;
};

export type FeedItem = {
  title: string;
  /** Canonical document URL. */
  link: string;
  /** Stable non-URL identifier (the record's at:// URI) — isPermaLink=false. */
  guid: string;
  /** RFC 822 date (see rfc822Date); omitted when absent. */
  pubDate?: string | null;
  /** Summary/excerpt; omitted when absent. */
  description?: string | null;
  /**
   * The post's full text as an HTML fragment, for `<content:encoded>`.
   * Omitted when absent.
   *
   * A feed carrying only an excerpt is a downgrade for anyone who reads in a
   * feed reader, and it quietly undercuts the claim that the feed is the
   * machine-readable twin of the page — the whole text is in the record either
   * way, so withholding it here serves nobody. `description` stays as the
   * summary, which is what `content:encoded` exists alongside rather than
   * replaces: readers that show a preview list still have something short to
   * show.
   */
  content?: string | null;
};

/** Hard per-value bound in the serialized feed. Record fields (titles,
 * descriptions) arrive from arbitrary PDSes with NO size cap — clamping at
 * the serialization choke point bounds both the escaping cost and the
 * document size no matter what a hostile record carries. A clamp landing
 * mid-surrogate-pair is repaired by escapeXml's lone-surrogate handling. */
const MAX_VALUE_CHARS = 2048;

/**
 * The same bound for `<content:encoded>`, which carries whole posts rather
 * than titles and so needs its own number. 256 KB is far above any real essay
 * (a 10,000-word piece rendered to HTML is well under 100 KB) and still bounds
 * what one hostile record can make us escape and serialize.
 *
 * Truncation is silent here, deliberately: the alternative is appending a
 * marker into somebody's post, and a feed item is not the place to editorialize
 * about a record's size. The canonical text is always one `link` away.
 */
const MAX_CONTENT_CHARS = 256 * 1024;

function xmlValue(value: string, limit = MAX_VALUE_CHARS): string {
  return escapeXml(value.slice(0, limit));
}

/** Serializes a channel + items into an RSS 2.0 document. Every dynamic
 * value is clamped and escaped here — callers pass raw strings, never
 * pre-escaped ones. */
export function rssFeedXml(channel: FeedChannel, items: FeedItem[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    "  <channel>",
    `    <title>${xmlValue(channel.title)}</title>`,
    `    <link>${xmlValue(channel.link)}</link>`,
    `    <description>${xmlValue(channel.description)}</description>`,
    `    <atom:link href="${xmlValue(channel.selfUrl)}" rel="self" type="application/rss+xml"/>`,
  ];
  for (const item of items) {
    lines.push(
      "    <item>",
      `      <title>${xmlValue(item.title)}</title>`,
      `      <link>${xmlValue(item.link)}</link>`,
      `      <guid isPermaLink="false">${xmlValue(item.guid)}</guid>`,
    );
    if (item.pubDate) {
      lines.push(`      <pubDate>${xmlValue(item.pubDate)}</pubDate>`);
    }
    if (item.description) {
      lines.push(
        `      <description>${xmlValue(item.description)}</description>`,
      );
    }
    if (item.content) {
      // Entity-escaped, not CDATA — same rule as every other value in this
      // file, and it is what the module's own spec allows. Escaping is what
      // makes the payload inert on the way through: a feed reader unescapes it
      // back to markup, an XML parser that does not simply sees text, and
      // there is no `]]>` to get wrong.
      lines.push(
        `      <content:encoded>${xmlValue(item.content, MAX_CONTENT_CHARS)}</content:encoded>`,
      );
    }
    lines.push("    </item>");
  }
  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}
