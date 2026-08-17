import { createFileRoute } from "@tanstack/react-router";

import { isDid, isHandle } from "~/lib/atproto";

/**
 * The answer /api/subscribe gives a reader whose browser has no JavaScript.
 *
 * With JavaScript the capture form renders its own outcome in place and nobody
 * ever arrives here. Without it, the browser navigates to whatever the POST
 * returns — so this page exists to be that destination, because the two
 * alternatives are both wrong: a JSON body is a dead end in a browser window,
 * and the reading page the reader came from cannot show the outcome itself (those
 * pages are edge-cached on a key that ignores the query string, so a `?saved=1`
 * would either miss the state or serve one reader's confirmation to everybody
 * for a minute).
 *
 * CALM REGISTER AND NO CHROME, like the reading-surface not-found pages: the
 * reader is mid-journey through somebody's publication, and dropping them onto a
 * Goldroad-branded page with our header would end that journey to announce our
 * involvement in it. One page, the fact, and the way back.
 *
 * `to` is the publication's handle or DID, and it is validated as one — the link
 * back is a path we build from a vetted identifier rather than a location handed
 * to us by a form field, which is how open redirects happen. `failed` marks the
 * refusal, which every tripwire on the endpoint shares.
 *
 * noindex: this page only means something to the reader who just posted a form.
 *
 * TWO THINGS ABOUT `failed` ARE THE ROUTER'S BEHAVIOUR RATHER THAN TASTE, and
 * both were only visible on a served page:
 *
 *   - The URL is normalized to whatever this function returns, so `failed: false`
 *     made every successful confirmation 307 to `?failed=false` before rendering.
 *     Absent, not falsy: a reader without JavaScript is the only person who ever
 *     sees this page, and they would have paid for that round trip and then read
 *     the word "failed" in their address bar.
 *   - Search VALUES ARRIVE PARSED, not as strings: `?failed=1` reaches here as the
 *     number 1, so a `=== "1"` check saw nothing, dropped the flag, and rendered
 *     a refusal as a success. The endpoint spells it `true` for that reason, and
 *     the spellings a hand-typed URL might carry are accepted alongside it.
 */

/** Truthy in a URL, whichever way the router handed it over. */
function isFailedFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export const Route = createFileRoute("/subscribed")({
  validateSearch: (search: Record<string, unknown>) => {
    const to = search.to;
    return {
      to:
        typeof to === "string" && (isHandle(to) || isDid(to)) ? to : undefined,
      failed: isFailedFlag(search.failed) || undefined,
    };
  },
  head: () => ({
    meta: [
      { title: "Your email — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SubscribedPage,
});

function SubscribedPage() {
  const { to, failed } = Route.useSearch();
  return <SubscribedView failed={failed} to={to} />;
}

/** Props-in, exported for tests — not a route. */
export function SubscribedView({
  to,
  failed,
}: {
  /** The publication's handle or DID, already validated. */
  to?: string;
  failed?: boolean;
}) {
  const name = to ? `@${to}` : "this publication";
  const back = to ? `/@${encodeURIComponent(to)}` : "/";
  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      <main className="mx-auto max-w-[42rem] px-6 py-24">
        {failed ? (
          <>
            <h1 className="text-balance font-bold font-display text-3xl leading-[1.15]">
              Nothing was saved.
            </h1>
            <p className="mt-4 max-w-[52ch] text-ink-soft text-lg leading-relaxed">
              The address may have a typo — or the spam check needs JavaScript
              switched on, which is the one thing this form can't do without.
              Your address is not with {name}.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-balance font-bold font-display text-3xl leading-[1.15]">
              Your address is with {name}.
            </h1>
            <p className="mt-4 max-w-[52ch] text-ink-soft text-lg leading-relaxed">
              Email sending isn't switched on yet, so nothing will arrive today.
              When it is, this is the address {name} can write to.
            </p>
          </>
        )}
        <p className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 font-display text-sm">
          <a
            className="font-semibold text-ink underline underline-offset-2 transition-colors hover:text-ink-soft"
            href={back}
          >
            {failed ? `Back to ${name}` : `Keep reading ${name}`}
          </a>
          <a
            className="text-ink-soft underline underline-offset-2 transition-colors hover:text-ink"
            href="/privacy"
          >
            How your address is held
          </a>
        </p>
      </main>
    </div>
  );
}
