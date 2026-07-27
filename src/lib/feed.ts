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

/**
 * Best-effort plain-text head of a markdown/plaintext body, for feed item
 * descriptions when the record carries no explicit description. Lossy by
 * design: strips the common markdown constructs, collapses whitespace, and
 * truncates near `maxChars` on a word boundary with an ellipsis. The result
 * still goes through escapeXml at interpolation time.
 */
export function plainTextExcerpt(text: string, maxChars = 300): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
    .replace(/(\*{1,3}|_{1,3}|~~)/g, "") // emphasis markers
    .replace(/\s+/g, " ")
    .trim();
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

/** Serializes a channel + items into an RSS 2.0 document. Every dynamic value
 * is escaped here — callers pass raw strings, never pre-escaped ones. */
export function rssFeedXml(channel: FeedChannel, items: FeedItem[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.link)}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    `    <atom:link href="${escapeXml(channel.selfUrl)}" rel="self" type="application/rss+xml"/>`,
  ];
  for (const item of items) {
    lines.push(
      "    <item>",
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${escapeXml(item.link)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
    );
    if (item.pubDate) {
      lines.push(`      <pubDate>${escapeXml(item.pubDate)}</pubDate>`);
    }
    if (item.description) {
      lines.push(
        `      <description>${escapeXml(item.description)}</description>`,
      );
    }
    lines.push("    </item>");
  }
  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}
