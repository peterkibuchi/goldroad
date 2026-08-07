import { ExternalLink } from "~/components/external-link";
import type { PostConversation, Reply } from "~/lib/comments";

/**
 * The conversation under a post — replies to its Bluesky announcement, read
 * from the public network (~/lib/comments).
 *
 * Calm register, and more strictly than most: this is a stranger's writing
 * sitting under the writer's. Serif body at the article's own measure, hairline
 * rules, no colour (the writer's words own the page's one accent moment), no
 * badges, no counts, no reply buttons that aren't real. The section only
 * renders when there is something to read — the caller passes null otherwise
 * and nothing appears at all.
 *
 * Avatars are deliberately absent. They'd be ornament in this register, and
 * they'd mean every reader's browser fetching images from Bluesky's CDN just
 * to read a post — the reading surfaces route the writer's own images through
 * /img precisely so third-party hosts never see the reader.
 */
export function Conversation({
  conversation,
}: {
  conversation: PostConversation;
}) {
  const { replies, threadUrl, hasMore } = conversation;
  return (
    <section
      aria-labelledby="conversation-heading"
      className="mt-16 border-rule border-t pt-10"
    >
      <h2
        className="font-display font-semibold text-ink-soft text-xs uppercase tracking-wide"
        id="conversation-heading"
      >
        Conversation
      </h2>
      {/* The one line of explanation this needs, in plain words: where the
          replies came from, and that we are not the ones moderating them. */}
      <p className="mt-2 font-display text-ink-soft/80 text-xs">
        Replies from Bluesky, where this post was shared. Bluesky moderates
        them, not Goldroad.
      </p>
      <ul className="mt-6">
        {replies.map((reply) => (
          <ReplyRow key={reply.uri} reply={reply} />
        ))}
      </ul>
      <p className="mt-8 font-display text-sm">
        {/* Labelled by outcome. When the thread holds more than we render,
            the label says so rather than making the reader discover it. */}
        <ExternalLink
          className="font-semibold text-ink underline underline-offset-2 transition-colors hover:text-ink-soft"
          href={threadUrl}
        >
          {hasMore ? "Read the rest and reply on Bluesky" : "Reply on Bluesky"}
        </ExternalLink>
      </p>
    </section>
  );
}

function ReplyRow({ reply }: { reply: Reply }) {
  return (
    <li className="border-rule border-t py-5 first:border-t-0">
      <p className="font-display text-ink-soft text-sm">
        <span className="font-semibold text-ink">
          {reply.authorName ?? `@${reply.authorHandle}`}
        </span>
        {reply.authorName && <> @{reply.authorHandle}</>}
        {/* A writer answering in their own thread reads differently from a
            stranger doing it. Stated as a word, not a coloured pill. */}
        {reply.byAuthor && <> · author</>}
      </p>
      {/* Plain text, rendered as text: React escapes it, and we deliberately
          do NOT resolve the record's facets into links — auto-linkifying a
          stranger's URLs on someone else's reading page is not ours to do.
          `whitespace-pre-line` keeps the author's own line breaks. */}
      {/* `wrap-anywhere` for the same reason the writer's prose has it: reply
          text is arbitrary third-party content, and an unbroken URL in it was
          reaching the right gutter at 320. */}
      <p className="wrap-anywhere mt-2 whitespace-pre-line text-base text-ink leading-relaxed">
        {reply.text}
      </p>
      <p className="mt-2 font-display text-ink-soft text-xs">
        <ExternalLink
          className="transition-colors hover:text-ink"
          href={reply.url}
        >
          <time dateTime={reply.timestamp}>
            {formatReplyDate(reply.timestamp)}
          </time>
        </ExternalLink>
      </p>
    </li>
  );
}

/**
 * Short date for a reply's meta line ("5 Jan 2026"). Fixed locale + UTC, like
 * every other date on these surfaces, so the server and client agree and
 * hydration doesn't drift. Deliberately not the article's long-form
 * `formatDate`: a reply's timestamp is a footnote, not a byline.
 */
function formatReplyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
