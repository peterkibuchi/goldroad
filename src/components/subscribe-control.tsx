/**
 * The subscribe control — the reader's one act on a writer's page.
 *
 * INK, NEVER THE SPOT COLOUR, and that is not a preference. A reading page's
 * single accent moment is already spent (the writer's own words are the point of
 * the screen), and this is a quiet affordance on somebody else's publication
 * rather than a campaign for ours — a vermillion button here would be Goldroad
 * shouting over the writer whose page it is. Outlined ink that fills on hover,
 * square corners, no shadow, and it RECEDES to a hairline once subscribed: the
 * affordance has done its job and should stop asking.
 *
 * ONE TOGGLE BUTTON, not a pair. `aria-pressed` is what makes "Subscribed" mean
 * "press to undo" without a second label to keep in sync, and the visible text
 * is the whole accessible name, so voice control can say what it reads.
 *
 * IT RENDERS NOTHING UNTIL IT KNOWS, following the reader-edition switch in
 * ~/components/document-article for the same reason: the reading pages are
 * edge-cached on a key that ignores cookies, so this state cannot be in the
 * HTML — it is asked for after mount (see /api/subscription). The slot keeps its
 * height from the first paint regardless, so the answer arriving doesn't shove
 * the page under a reader who has started reading.
 *
 * NO SUBSCRIBER COUNT, here or anywhere. Counting the repos that point at a
 * publication is a reverse lookup the protocol doesn't offer (see
 * ~/lib/subscription), so there is no number — and a "0" beside a Subscribe
 * button would be a made-up one.
 */
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  readSubscriptionState,
  type SubscriptionState,
  signInHref,
  writeSubscription,
} from "~/lib/subscribe-client";
import { cn } from "~/lib/utils";

/** What just happened, for the announcement and the instruction line. */
type Note = "subscribed" | "unsubscribed" | "reconnect" | "failed";

const BUTTON =
  "inline-flex min-h-11 cursor-pointer items-center px-4 font-display font-semibold text-sm transition-colors disabled:cursor-default disabled:opacity-60";

export function SubscribeControl({
  publicationAtUri,
  className,
}: {
  /** The publication's record URI. Null for a document with no publication
   * record behind it — there is nothing to subscribe TO, so nothing renders. */
  publicationAtUri: string | null;
  className?: string;
}) {
  const { pathname } = useLocation();
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    if (!publicationAtUri) return;
    // Ignore an answer that arrives after the reader has navigated to another
    // publication — it would be the previous page's relationship.
    let live = true;
    readSubscriptionState(publicationAtUri).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [publicationAtUri]);

  if (!publicationAtUri) return null;
  // Bound after the guard: a destructured parameter's narrowing doesn't reach
  // into the closure below, and this reads better than asserting there.
  const publication = publicationAtUri;

  async function toggle(subscribe: boolean) {
    setPending(true);
    setNote(null);
    const result = await writeSubscription(publication, subscribe);
    setPending(false);
    if (!result.ok) {
      // The button keeps its old state: nothing changed, so it must not claim
      // otherwise. The line below says what to do next.
      setNote(result.reason);
      return;
    }
    setState({ status: "known", subscribed: result.subscribed });
    setNote(result.subscribed ? "subscribed" : "unsubscribed");
  }

  return (
    // The slot holds its height from the server render, so the answer arriving
    // after mount doesn't move the words under a reader.
    <span
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1",
        className,
      )}
    >
      {state?.status === "signed-out" && (
        // A link, because it navigates. `pathname` comes back through the one
        // open-redirect guard on the /login POST (see signInHref).
        <a
          className={cn(
            BUTTON,
            "border border-ink text-ink hover:bg-ink hover:text-paper",
          )}
          href={signInHref(pathname)}
        >
          Sign in to subscribe
        </a>
      )}
      {state?.status === "known" && (
        <button
          aria-busy={pending || undefined}
          aria-pressed={state.subscribed}
          className={cn(
            BUTTON,
            "border",
            state.subscribed
              ? "border-rule text-ink-soft hover:border-ink hover:text-ink"
              : "border-ink text-ink hover:bg-ink hover:text-paper",
          )}
          disabled={pending}
          onClick={() => toggle(!state.subscribed)}
          type="button"
        >
          {state.subscribed ? "Subscribed" : "Subscribe"}
        </button>
      )}
      {/* The outcome, announced. Not shown: the button's own label already
          carries it on screen, and repeating it beside the button would be
          ornament on a surface that wants none. */}
      <span className="sr-only" role="status">
        {note === "subscribed" && "Subscribed."}
        {note === "unsubscribed" && "Subscription removed."}
      </span>
      {(note === "reconnect" || note === "failed") && (
        // Ink, no box, no spot: a failed press is a fact about our plumbing, not
        // an alarm, and the page's accent moment isn't ours to spend.
        <span
          className="font-display text-ink-soft text-xs leading-relaxed"
          role="alert"
        >
          {note === "failed" ? (
            "That didn't go through — try again."
          ) : (
            <>
              <a
                className="underline underline-offset-2 transition-colors hover:text-ink"
                href={signInHref(pathname)}
              >
                Sign in again
              </a>{" "}
              to subscribe.
            </>
          )}
        </span>
      )}
    </span>
  );
}
