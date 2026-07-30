/**
 * The two pieces a writer-facing post summary is built from, shared by the
 * overview (/home) and the posts manager (/dashboard) so one post never
 * describes itself two different ways depending on which surface you're on.
 *
 * Pressroom register: ink and hairlines, no radius, no shadow. Neither piece
 * spends the vermillion accent — that belongs to the page's primary action.
 */
import { ExternalLink } from "~/components/external-link";
import { HeartIcon, ReplyIcon, RepostIcon } from "~/components/icons";
import { monogram } from "~/lib/archive";
import {
  type DocumentEngagement,
  hasVisibleEngagement,
} from "~/lib/engagement";
import { cn } from "~/lib/utils";

/**
 * Fixed-size thumbnail slot: the post's cover if it has one, else a quiet
 * monogram of its title. Always the same box, so a cover-less post never
 * leaves a hole in a list's rhythm.
 *
 * Unlike the public archive's thumbnail, this one deliberately does NOT fall
 * back to the publication icon: on the writer's own surfaces every row would
 * then carry the same image, which is the opposite of a scanning aid.
 */
export function PostThumb({
  coverPath,
  title,
  className,
}: {
  coverPath: string | null;
  title: string;
  className?: string;
}) {
  const box = cn("size-14 shrink-0 sm:size-16", className);
  if (coverPath) {
    return (
      <img
        alt=""
        className={cn(box, "object-cover")}
        loading="lazy"
        src={coverPath}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        box,
        "flex items-center justify-center bg-ink/5 font-display text-ink-soft/40 text-xl",
      )}
    >
      {monogram(title)}
    </div>
  );
}

/**
 * Quick metrics for one post: reader views, then the cross-network
 * conversation its announcement collected.
 *
 * Every metric here is independently optional and EVERY absence renders as
 * nothing at all — never a zero. `views` is undefined when the analytics
 * provider never recorded that path (cookieless analytics genuinely miss
 * readers, and older posts predate the seam); `engagement` is null when the
 * post was never announced, and an announced post whose counts all came back
 * uncounted renders nothing too. A "0" here would be a claim the data cannot
 * support, and a writer reading a false zero would draw exactly the wrong
 * conclusion about their own work.
 *
 * Returns null when there is nothing honest to show, so callers can drop the
 * whole slot rather than reserve an empty one.
 */
export function PostMetrics({
  views,
  engagement,
}: {
  views?: number;
  engagement?: DocumentEngagement | null;
}) {
  const counts = engagement?.counts;
  const showEngagement = counts !== undefined && hasVisibleEngagement(counts);
  if (views === undefined && !showEngagement) return null;

  const reposts = (counts?.repostCount ?? 0) + (counts?.quoteCount ?? 0);
  const showReposts =
    counts?.repostCount !== undefined || counts?.quoteCount !== undefined;

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-display text-ink-soft text-xs">
      {/* One weight across the whole cluster: views and cross-network counts
          are peers, and a bolded number would rank one above the others. */}
      {views !== undefined && (
        <span title="Reader views, counted without cookies">
          {`${views.toLocaleString()} ${views === 1 ? "view" : "views"}`}
        </span>
      )}
      {showEngagement && counts && engagement && (
        <>
          {counts.likeCount !== undefined && (
            <span
              className="inline-flex items-center gap-1"
              title={`${counts.likeCount} likes on Bluesky`}
            >
              <HeartIcon className="h-3.5 w-3.5" />
              {counts.likeCount}
            </span>
          )}
          {counts.replyCount !== undefined && (
            <ExternalLink
              className="-my-2 inline-flex min-h-9 items-center gap-1 transition-colors hover:text-ink"
              href={engagement.threadUrl}
              title="View the replies on Bluesky"
            >
              <ReplyIcon className="h-3.5 w-3.5" />
              {counts.replyCount}
            </ExternalLink>
          )}
          {showReposts && (
            <span
              className="inline-flex items-center gap-1"
              title={`${reposts} reposts and quotes on Bluesky`}
            >
              <RepostIcon className="h-3.5 w-3.5" />
              {reposts}
            </span>
          )}
        </>
      )}
    </span>
  );
}
