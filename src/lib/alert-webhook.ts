/**
 * The envelope an alert has to wear to be delivered at all.
 *
 * WHY THIS EXISTS. Two senders POST to the one optional `WEBHOOK_URL` — the
 * cron self-check (~/lib/scheduled) and the abuse-report pass (~/lib/reports) —
 * and the URL an operator actually pastes in is a chat webhook. Discord answers
 * 400 to any POST carrying none of `content`, `embeds`, `components`, `file` or
 * `poll`; Slack wants `text`. A body made only of our own structured fields is
 * therefore a message that is never delivered, on every tick, by both senders —
 * and it fails at the destination rather than in our code, which is why it can
 * look healthy from here.
 *
 * So every alert leads with a one-line human summary in BOTH fields and keeps
 * its structured fields alongside: `content` is what Discord renders, `text` is
 * what Slack renders, and a plain JSON sink ignores both and reads the rest.
 * The summary is the whole message a chat reader sees — the structured fields
 * are not rendered there — so it has to say the useful thing by itself.
 */

/**
 * How long that line may be.
 *
 * It is assembled from strings we do not control: a self-check failure can
 * embed a `String(err)` or a `client_id` read off a remote response, and the
 * abuse path's fields arrive from an anonymous endpoint. A summary is a
 * headline pointing at the structured payload, so it is clipped hard and
 * unconditionally rather than trusted to be short.
 */
export const MAX_ALERT_SUMMARY_CHARS = 180;

/** `text` shortened to `max` characters, marked as shortened. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The two fields chat webhooks look for, both carrying the same one line. */
export type ChatSummary = { content: string; text: string };

/**
 * Collapse a summary to a single clipped line and put it in both fields.
 *
 * Newlines are folded away deliberately: a failure string carrying a stack
 * trace would otherwise turn one headline into a wall, which is the shape that
 * gets rejected or ignored.
 */
export function chatSummary(summary: string): ChatSummary {
  const line = clip(
    summary.replace(/\s+/g, " ").trim(),
    MAX_ALERT_SUMMARY_CHARS,
  );
  return { content: line, text: line };
}
