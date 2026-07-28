/**
 * Reading-time estimate for the byline (document page) and post-list rows
 * (publication page): a simple words-per-minute heuristic over the
 * markdown/plaintext `textContent` body. Delegates all markdown stripping
 * to the shared hardened strip in ~/lib/feed — never fork it (see that
 * file's own note on why the pre-hardening copies went quadratic).
 */
import { stripMarkdown } from "~/lib/feed";

/** Average adult silent-reading speed for non-fiction prose, words/minute —
 * a conservative, widely-cited middle value. Reusable across both call sites
 * below so the two surfaces never drift apart. */
const WORDS_PER_MINUTE = 225;

/** Defensive upper bound for a SINGLE document's reading-time scan —
 * mirrors ~/lib/publish's MAX_BODY_LENGTH precedent for exactly this
 * one-record case (that file reasons the same bound is safe there) without
 * importing the write-path module into the read path. Third-party
 * `textContent` carries no lexicon size cap; this still bounds the
 * regex-scan cost against a truly oversized hostile record — 100k
 * characters comfortably covers any realistic article. */
const SINGLE_DOCUMENT_SCAN_CHARS = 100_000;

/**
 * Core estimate: strip markdown syntax, count words, divide by wpm, round
 * UP to the nearest minute. "Honest rounding" here means never rounding
 * down to a number that undersells the piece — a reader finding an
 * article a little shorter than promised is fine; finding it ran long
 * after being told "2 min read" is not.
 *
 * `scanChars` bounds the regex-stripping window exactly like stripMarkdown's
 * other callers: `textContent` arrives from arbitrary PDSes with no size
 * cap. Leave it at stripMarkdown's own default when the call sits inside a
 * multi-record loop (the publication list, like the RSS feed, reads up to
 * 50 posts per request); pass a larger bound only for a single-record read.
 */
export function readingTimeMinutes(
  text: string,
  scanChars?: number,
  wpm = WORDS_PER_MINUTE,
): number {
  const plain =
    scanChars === undefined
      ? stripMarkdown(text)
      : stripMarkdown(text, scanChars);
  const words = plain.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.max(1, Math.ceil(words / wpm));
}

/**
 * Document-page byline: the page renders exactly one record, so this can
 * afford a much larger scan window than a list loop — see
 * SINGLE_DOCUMENT_SCAN_CHARS above.
 */
export function documentReadingMinutes(text: string, wpm = WORDS_PER_MINUTE) {
  return readingTimeMinutes(text, SINGLE_DOCUMENT_SCAN_CHARS, wpm);
}

/**
 * Publication-list row: this runs inside a per-request loop over up to 50
 * posts, the same shape ~/lib/feed's RSS excerpt bounds for exactly this
 * reason — leave the scan window at stripMarkdown's own conservative
 * default so a page of hostile-length third-party posts can't blow the
 * Workers CPU budget. Longer posts may show a slight undercount here; the
 * document page itself (above) always scores the honest full estimate.
 */
export function listItemReadingMinutes(text: string, wpm = WORDS_PER_MINUTE) {
  return readingTimeMinutes(text, undefined, wpm);
}

/** "3 min read", or null when there's no body to estimate from (empty
 * documents, or documents whose full text lives elsewhere). */
export function formatReadingTime(minutes: number): string | null {
  return minutes > 0 ? `${minutes} min read` : null;
}
