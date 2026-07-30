/**
 * "Your conversation on Bluesky" — the one thing a closed platform can't show a
 * writer, because on a closed platform the conversation happens inside the
 * platform.
 *
 * These are real counts on real posts, pulled live from the public network, each
 * row with a door straight into its thread. It also has no cold start: it works
 * on a writer's first shared post, on day one, with no history at all. So it gets
 * the panel, not a footnote — a 2px ink frame while every other section on the
 * page is separated by hairlines. Weight, not colour, says "this matters" here.
 *
 * Two honesty rules run through it. A post that was never shared has no thread,
 * so it is reported as a COUNT of posts rather than as rows of zeros — "0 likes"
 * would state that nobody engaged, which is a different and false claim. And when
 * only some of the counts came back, the aggregate says what it was computed
 * over: a partial sum presented as a total is the worst outcome available here.
 */
import { ExternalLink } from "~/components/external-link";
import { bskyPostUrl } from "~/lib/engagement";
import type { EngagementSection } from "~/lib/stats-sections";
import {
  formatCount,
  LINK_CLASS,
  LoadingRegion,
  Metric,
  QuietLine,
  SkeletonBar,
} from "./shared";

const PROVENANCE =
  "These are the real likes, reposts and replies your posts earned on Bluesky — the same ones anyone can see there, on posts that stay yours if you ever leave. Open any thread to join in.";

/** A count with its noun spelled out. An unlabelled heart beside an unlabelled
 * arrow-loop is a guessing game. */
function Count({ value, noun }: { value: number | null; noun: string }) {
  return (
    <span className="whitespace-nowrap font-display text-ink text-sm tabular-nums">
      <Metric value={value} />{" "}
      <span className="text-ink-soft text-xs">{noun}</span>
    </span>
  );
}

function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="engagement-heading"
      className="mt-10 border-2 border-ink px-4 py-5 sm:px-6 sm:py-6"
    >
      <h2
        className="font-black font-display text-ink text-lg tracking-tight"
        id="engagement-heading"
      >
        Your conversation on Bluesky
      </h2>
      {children}
    </section>
  );
}

export type EngagementRow = {
  rkey: string;
  title: string;
  date: string | null;
  publishedAt: string | null;
  likes: number | null;
  reposts: number | null;
  quotes: number | null;
  replies: number | null;
  gone: boolean;
  threadUrl: string;
};

/** Joins the section's counts onto the loader's titles. Rows whose post isn't in
 * the loader page are kept with a placeholder title rather than dropped — a
 * vanished row reads as a bug. */
export function engagementRows(
  section: EngagementSection,
  titles: Map<
    string,
    { title: string; publishedAt: string | null; date: string | null }
  >,
): EngagementRow[] {
  return (section.posts ?? []).map((post) => {
    const meta = titles.get(post.rkey);
    return {
      rkey: post.rkey,
      title: meta?.title ?? "(untitled)",
      date: meta?.date ?? null,
      publishedAt: meta?.publishedAt ?? null,
      likes: post.likes,
      reposts: post.reposts,
      quotes: post.quotes,
      replies: post.replies,
      gone: post.gone === true,
      threadUrl: bskyPostUrl(post.did, post.postRkey),
    };
  });
}

export function EngagementPanel({
  engagement,
  rows,
  postHref,
}: {
  engagement: EngagementSection | null;
  rows: EngagementRow[];
  postHref: (rkey: string) => string;
}) {
  if (engagement === null) {
    return (
      <PanelFrame>
        <LoadingRegion label="Loading your Bluesky conversation…">
          <SkeletonBar className="mt-3 h-3 w-72 max-w-full" />
          <div className="mt-5">
            {[0, 1, 2].map((index) => (
              <div className="border-rule border-b py-3" key={index}>
                <SkeletonBar className="h-4 w-full" />
              </div>
            ))}
          </div>
        </LoadingRegion>
      </PanelFrame>
    );
  }

  if (engagement.status === "unavailable") {
    return (
      <PanelFrame>
        <QuietLine className="mt-3">
          Bluesky counts couldn't be loaded right now. Refresh to try again.
        </QuietLine>
      </PanelFrame>
    );
  }

  // The highest-value empty state on the surface: it turns a writer who has
  // published into a writer who is distributing. A teaching panel, not an error.
  if (engagement.status === "empty" || rows.length === 0) {
    return (
      <PanelFrame>
        <p className="mt-3 max-w-[62ch] text-ink-soft leading-relaxed">
          Announcing a post puts it in front of your Bluesky followers as a card
          that links back here — and the likes, reposts and replies it earns
          show up on this page.
        </p>
        <p className="mt-3 font-display text-sm">
          <a className={LINK_CLASS} href="/dashboard">
            Announce a post from Posts
          </a>
        </p>
      </PanelFrame>
    );
  }

  const totals = engagement.totals;
  const counted = engagement.countedPosts ?? 0;
  const requested = engagement.requestedPosts ?? counted;
  const partial = counted < requested;

  return (
    <PanelFrame>
      {/* The differentiator's argument, in the plainest true sentence available.
          Not decoration — this is the line a writer is most likely to screenshot. */}
      <p className="mt-3 max-w-[68ch] text-ink-soft leading-relaxed">
        {PROVENANCE}
      </p>

      {totals && (
        <p className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <Count noun="likes" value={totals.likes} />
          <Count noun="reposts" value={totals.reposts} />
          <Count noun="quotes" value={totals.quotes} />
          <Count noun="replies" value={totals.replies} />
          <span className="font-display text-ink-soft text-xs">
            across {formatCount(counted)} {counted === 1 ? "post" : "posts"} you
            shared to Bluesky
          </span>
        </p>
      )}

      {partial && (
        <QuietLine className="mt-2">
          Counted across {formatCount(counted)} of your {formatCount(requested)}{" "}
          shared posts — the rest didn't answer just now.
        </QuietLine>
      )}

      <ul className="mt-4 border-ink border-t">
        {rows.map((row) => (
          <li className="border-rule border-b py-3" key={row.rkey}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <span className="min-w-0">
                <a className={LINK_CLASS} href={postHref(row.rkey)}>
                  <span className="font-semibold text-ink">{row.title}</span>
                </a>
                {row.date && (
                  <span className="ml-3 font-display text-ink-soft text-xs">
                    <time dateTime={row.publishedAt ?? undefined}>
                      {row.date}
                    </time>
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:shrink-0">
                <Count noun="likes" value={row.likes} />
                <Count noun="reposts" value={row.reposts} />
                <Count noun="quotes" value={row.quotes} />
                {/* Replies are the comment section, so the number is the door. */}
                <ExternalLink
                  className={`whitespace-nowrap font-display text-sm tabular-nums ${LINK_CLASS}`}
                  href={row.threadUrl}
                >
                  <Metric value={row.replies} />{" "}
                  <span className="text-xs">replies ↗</span>
                </ExternalLink>
              </span>
            </div>
            {row.gone && (
              <QuietLine className="mt-1">
                The announcement for this post isn't on Bluesky anymore.
              </QuietLine>
            )}
          </li>
        ))}
      </ul>

      <QuietLine className="mt-3">
        A dash means we have no number for it, not zero.
      </QuietLine>

      {(engagement.unannouncedCount ?? 0) > 0 && (
        <QuietLine className="mt-1">
          {formatCount(engagement.unannouncedCount ?? 0)}{" "}
          {engagement.unannouncedCount === 1 ? "post hasn't" : "posts haven't"}{" "}
          been shared to Bluesky yet — no conversation to show yet.{" "}
          <a className={LINK_CLASS} href="/dashboard">
            Share them from Posts.
          </a>
        </QuietLine>
      )}
    </PanelFrame>
  );
}
