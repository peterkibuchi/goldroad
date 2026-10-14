/**
 * The reader's half of post search, with no database in it: what a typed query
 * becomes before it reaches FTS5, and how a highlighted snippet comes back out.
 * Pure, so the archive page can use it on both server and client.
 */

/** Longest query kept from the URL. A search box, not a document. */
export const MAX_QUERY_LENGTH = 200;

/** Words a query is cut to. Each is another doclist for the index to read. */
export const MAX_QUERY_TERMS = 8;

/** The query as the archive URL carries it: trimmed, single-spaced, capped.
 * Anything that isn't a string is no query at all. */
export function normalizeQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * A reader's words → an FTS5 MATCH expression, or null when there's nothing
 * to look for.
 *
 * Never the raw text: FTS5 has its own syntax (quotes, `AND`/`OR`/`NOT`,
 * `column:`, `^`, `*`, parentheses), and handing it what someone typed turns a
 * stray quote into a query error and a pasted `NOT` into a different search.
 * So the query is cut into words (letters and digits, in any script) and each
 * one is quoted, which makes every word a plain term. Every word must appear
 * (FTS5's implicit AND), and each of two or more characters matches as a
 * prefix, so "softw" finds "software" and a half-typed last word still finds
 * something. A single character matches only itself: as a prefix it would be
 * every word that starts with it.
 */
export function toMatchExpression(query: string): string | null {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  return [...new Set(words)]
    .slice(0, MAX_QUERY_TERMS)
    .map((word) => ([...word].length > 1 ? `"${word}"*` : `"${word}"`))
    .join(" ");
}

/**
 * The markers FTS5 wraps around a matched word in a snippet. Control
 * characters rather than `<mark>`, so the snippet is plain text all the way to
 * the page, where it is split into text and highlight nodes: a snippet is the
 * writer's text, and must never be parsed as HTML. The indexer strips both
 * characters from what it stores, so a post can't fake a highlight.
 */
export const HIT_OPEN = "\u0002";
export const HIT_CLOSE = "\u0003";

/** Strips the snippet markers from text about to be indexed. */
export function withoutHitMarkers(text: string): string {
  return text.replaceAll(HIT_OPEN, "").replaceAll(HIT_CLOSE, "");
}

export type SnippetPart = { text: string; hit: boolean };

/** A marked-up snippet → runs of plain and matched text, in order. */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let start = 0;
  const flush = (end: number) => {
    if (end > start) parts.push({ text: snippet.slice(start, end), hit });
  };
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (ch !== HIT_OPEN && ch !== HIT_CLOSE) continue;
    flush(i);
    hit = ch === HIT_OPEN;
    start = i + 1;
  }
  flush(snippet.length);
  return parts;
}
