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
  return text
    .slice(0, scanChars)
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!\[([^[\]]*)\]\([^()]*\)/g, "$1") // images → alt text
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1") // links → link text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
    .replace(/(\*{1,3}|_{1,3}|~~)/g, "") // emphasis markers
    .replace(/\s+/g, " ")
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
};

/** Hard per-value bound in the serialized feed. Record fields (titles,
 * descriptions) arrive from arbitrary PDSes with NO size cap — clamping at
 * the serialization choke point bounds both the escaping cost and the
 * document size no matter what a hostile record carries. A clamp landing
 * mid-surrogate-pair is repaired by escapeXml's lone-surrogate handling. */
const MAX_VALUE_CHARS = 2048;

function xmlValue(value: string): string {
  return escapeXml(value.slice(0, MAX_VALUE_CHARS));
}

/** Serializes a channel + items into an RSS 2.0 document. Every dynamic
 * value is clamped and escaped here — callers pass raw strings, never
 * pre-escaped ones. */
export function rssFeedXml(channel: FeedChannel, items: FeedItem[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
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
    lines.push("    </item>");
  }
  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}
