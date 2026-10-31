/**
 * Sharing a post to Bluesky, as a link to Bluesky's own composer.
 *
 * Nothing is posted from here: the reader lands in their composer with the
 * text filled in, edits it if they like, and posts it themselves. So there is
 * no request to us, no Worker time and nothing to track, and a reader who is
 * signed out of Bluesky gets Bluesky's own sign-in.
 *
 * Bluesky refuses a post over 300 graphemes, and a composer opened over the
 * limit makes the reader trim it by hand. So the text is cut to fit with an
 * ellipsis, and the link is never the part that gets cut: a quote that lost
 * its link has lost the writer.
 */

/** Bluesky's post limit, in graphemes (what a reader sees as characters). */
export const BLUESKY_POST_LIMIT = 300;

const COMPOSE_URL = "https://bsky.app/intent/compose";

/**
 * Splits text into graphemes, so an emoji or an accented letter is never cut
 * in half. `Intl.Segmenter` is the only correct way, and also the expensive
 * one to start (it loads ICU data), so callers reach it only for text that
 * might be over the limit; code points are the fallback where it is missing.
 */
let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string, max: number): string[] {
  let all: Iterable<string | Intl.SegmentData> = text;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    segmenter ??= new Intl.Segmenter();
    all = segmenter.segment(text);
  }
  // Stop at `max`: a reader selecting a long passage with the keyboard
  // re-runs this on every keystroke, and truncation reads no further.
  const parts: string[] = [];
  for (const part of all) {
    parts.push(typeof part === "string" ? part : part.segment);
    if (parts.length >= max) break;
  }
  return parts;
}

/**
 * `text` cut to `budget` graphemes, ending in an ellipsis when it was cut.
 *
 * Cuts at the last space when one is close, so a quote ends on a whole word,
 * but never throws away more than a fifth of the budget to find one: a long
 * URL or a run of CJK has no spaces, and an empty quote helps nobody.
 */
export function truncateGraphemes(text: string, budget: number): string {
  // A string's graphemes never outnumber its UTF-16 units, so short text
  // needs no segmenting. That is nearly every title, which keeps the share
  // link out of ICU during hydration.
  if (text.length <= budget) return text;
  const parts = graphemes(text, budget + 1);
  if (parts.length <= budget) return text;
  let keep = Math.max(budget - 1, 0);
  // Mid-word only if the cut fell between two letters of one word.
  if (/\S/.test(parts[keep] ?? "")) {
    let space = keep - 1;
    while (space > 0 && !/\s/.test(parts[space])) space--;
    if (space > keep * 0.8) keep = space;
  }
  const cut = parts.slice(0, keep).join("");
  return `${cut.replace(/[\s.,;:!?…]+$/u, "")}…`;
}

function composeUrl(text: string): string {
  return `${COMPOSE_URL}?text=${encodeURIComponent(text)}`;
}

/**
 * The composer, filled with `lead`, a blank line and `url`, with `lead` cut so
 * the whole post fits. `wrap` adds characters around the lead after cutting
 * (a quote's marks), and is counted against the limit first.
 */
function shareUrl(lead: string, url: string, wrap = (s: string) => s) {
  const fixed = wrap("").length + url.length + 2;
  const room = BLUESKY_POST_LIMIT - fixed;
  if (room < 1) return composeUrl(url);
  return composeUrl(`${wrap(truncateGraphemes(lead, room))}\n\n${url}`);
}

/** Share the post itself: its title, then its link. */
export function postShareUrl(title: string | undefined, url: string): string {
  const lead = title?.trim();
  return lead ? shareUrl(lead, url) : composeUrl(url);
}

/** Share a passage: the reader's selection in quote marks, then the link. */
export function passageShareUrl(passage: string, url: string): string {
  return shareUrl(tidyQuote(passage), url, (s) => `“${s}”`);
}

/** Collapses a selection's layout whitespace: runs of spaces become one, and
 * the gap between two paragraphs becomes a single blank line. */
export function tidyQuote(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
