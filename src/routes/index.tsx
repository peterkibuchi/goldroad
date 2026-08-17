import { IconHeart, IconMessageCircle, IconRepeat } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import {
  CtaLink,
  Kicker,
  MarketingSection,
  QuietLink,
  RegMark,
} from "~/components/marketing";
import { Notice } from "~/components/notice";
import { SiteFooter, SiteHeader } from "~/components/site-chrome";
import { MAIN_CONTENT_ID } from "~/components/skip-link";
import {
  resetTurnstileWidgets,
  TURNSTILE_TOKEN_FIELD,
  TurnstileWidget,
} from "~/components/turnstile";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { capture } from "~/lib/posthog";
import { DEFAULT_CARD_META } from "~/lib/social-card";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: { notice?: "goodbye" } = {};
    if (search.notice === "goodbye") out.notice = "goodbye";
    return out;
  },
  head: () => ({
    meta: [
      { title: "Goldroad — your publication on the open network" },
      {
        name: "description",
        content:
          "Your followers are already your readers. Goldroad turns your Bluesky handle into a publication: long-form on a page you own, sent to the timeline as a native card. Your posts, your name, your archive — portable, and when reader payments ship we take 0% of what readers pay you.",
      },
      { property: "og:title", content: "Goldroad" },
      {
        property: "og:description",
        content:
          "Your followers are already your readers — long-form on a page you own, sent to the Bluesky timeline as a native card. When reader payments ship, we take 0% of what readers pay you.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${CANONICAL_ORIGIN}/` },
      // This page shows the default card, so this page describes it.
      ...DEFAULT_CARD_META,
    ],
    links: [{ rel: "canonical", href: `${CANONICAL_ORIGIN}/` }],
  }),
  component: LandingRoute,
});

/**
 * Hero-headline variants for a future `landing_variant` PostHog A/B on the
 * marketing hero's messaging. `control` is the shipped default; `challenger`
 * is wired here so turning the experiment on later is a one-line branch. The
 * A/B is deliberately NOT built while traffic is too low to measure anything
 * but noise. To run it: read the `landing_variant` flag, render
 * HERO_HEADLINES[variant] in the hero, and pass { landing_variant } to
 * capture("waitlist_joined") below. The control's spot-highlight span sits on
 * "your readers"; a challenger render would highlight "0% taken".
 */
export const HERO_HEADLINES = {
  control: "Your followers are already your readers.",
  // NOT "your domain" — custom domains are not built, and a variant nobody has
  // rendered yet is exactly where a false claim hides until the day it ships.
  challenger: "Your publication. Your readers. Your name. 0% taken.",
} as const;

const STEPS = [
  {
    title: "Sign in with Bluesky",
    body: "Your handle is your account. The readers you've already earned come with you — nothing to rebuild.",
  },
  {
    title: "Write the long one",
    body: "A calm, focused editor for the piece that never fit in a post. Headings, quotes, footnotes, images — and a schedule, if you write to a weekly slot.",
  },
  {
    title: "Publish to a page you own",
    body: "Every piece gets a fast, quiet page — and the original is saved to a data repo that's yours, portable anywhere.",
  },
  {
    title: "Send it to the timeline",
    body: "One tap posts it to Bluesky as a rich card linking back to your page. Readers reply there, and the conversation shows up under your post.",
  },
];

const REASONS = [
  {
    title: "Day-one readers",
    body: "The followers you've earned are your launch list. Publish this afternoon; they can read it this afternoon.",
  },
  {
    title: "A card, not a bare link",
    body: "Your posts land as first-class cards — cover, title, summary — because Goldroad publishes in the network's own format.",
  },
  {
    title: "Yours on every app",
    body: "Your page's look travels with your account. Apps nobody at Goldroad wrote will honour it, because it's stored in a format we share rather than a database we keep.",
  },
];

/**
 * The hero proof visual: a writer's essay as it renders in the Bluesky
 * timeline — a native rich card, not a naked link. Pressroom treatment (ink
 * rules, zero radius, no glass). One `role="img"` node carries the full
 * description so assistive tech
 * hears the point once; the illustrative figures stay out of the a11y tree.
 * The handle uses the RFC-2606 reserved `.example` domain — a fictional
 * identity on a marketing surface must never resolve to a real account.
 */
function TimelineCard() {
  return (
    <figure className="m-0">
      <div
        aria-label="A Bluesky post by Sana Adeyemi announcing a new essay, shown as the rich preview card it becomes in the timeline: the publication name, the essay title and summary, and trygoldroad.com as the source."
        className="border-2 border-ink bg-paper p-4 sm:p-5"
        role="img"
      >
        <div aria-hidden="true" className="flex items-center gap-3">
          <span className="inline-grid size-10 place-items-center rounded-full bg-ink font-bold font-display text-paper text-sm">
            SA
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate font-bold font-display text-ink text-sm">
              Sana Adeyemi
            </span>
            <span className="block truncate font-display text-ink-soft text-xs">
              @sana.example · 2h
            </span>
          </span>
        </div>
        <p aria-hidden="true" className="mt-3 text-ink text-sm leading-normal">
          New essay — on group chats as the last honest public square.
        </p>
        <div aria-hidden="true" className="mt-3 border border-ink">
          <div className="flex items-center gap-2 border-ink border-b bg-ink px-4 py-2.5">
            <RegMark className="size-3.5 text-paper opacity-80" />
            <span className="font-display font-semibold text-[0.7rem] text-paper uppercase tracking-[0.12em]">
              Sana Adeyemi
            </span>
          </div>
          <div className="px-4 py-3">
            <p className="font-bold font-display text-ink text-sm leading-snug">
              The Group Chat Is the Village Green
            </p>
            <p className="mt-1 text-ink-soft text-xs leading-snug">
              Twelve people, one thread, no algorithm. What we rebuilt when the
              feeds stopped feeling like home.
            </p>
            <p className="mt-2 font-display text-[0.7rem] text-ink-soft uppercase tracking-[0.1em]">
              trygoldroad.com
            </p>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="mt-3 flex items-center gap-8 font-display text-ink-soft text-xs"
        >
          <span className="flex items-center gap-1.5">
            <IconMessageCircle
              className="text-ink-soft"
              size={17}
              stroke={1.75}
            />
            41
          </span>
          <span className="flex items-center gap-1.5">
            <IconRepeat className="text-ink-soft" size={17} stroke={1.75} />
            128
          </span>
          <span className="flex items-center gap-1.5">
            <IconHeart className="text-ink-soft" size={17} stroke={1.75} />
            512
          </span>
        </div>
      </div>
      <figcaption className="mt-3 font-display text-ink-soft text-xs">
        Your essay in the timeline — a native card, not a naked link. Sample
        post; figures illustrative.
      </figcaption>
    </figure>
  );
}

type FormState = "idle" | "sending" | "done" | "error";

/**
 * Launch-updates signup — an email list, not an access gate. While the
 * marketing chrome carries no sign-in link, this form is the page's sole
 * primary action.
 */
function FoundingWritersForm() {
  const [state, setState] = useState<FormState>("idle");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setState("sending");
    // Present only when the Turnstile widget rendered (sitekey configured);
    // without it the payload stays exactly the pre-Turnstile shape.
    const turnstileToken = data.get(TURNSTILE_TOKEN_FIELD);
    try {
      const res = await fetch("/api/waitlist", {
        body: JSON.stringify({
          gr_extra: String(data.get("gr_extra") ?? ""),
          email: String(data.get("email") ?? ""),
          ...(typeof turnstileToken === "string"
            ? { [TURNSTILE_TOKEN_FIELD]: turnstileToken }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) throw new Error(String(res.status));
      // landing_variant A/B seam (see HERO_HEADLINES above): when the
      // experiment runs, pass the assigned flag —
      // capture("waitlist_joined", { landing_variant }) — and stamp the same
      // property on the pageview in __root. Event id stays `waitlist_joined`
      // (the analytics contract in ~/lib/posthog); only the copy is reframed.
      capture("waitlist_joined");
      setState("done");
      form.reset();
    } catch {
      // Tokens are single-use: the failed submit consumed this one, so the
      // widget must re-arm or every retry would resend a dead token.
      resetTurnstileWidgets();
      setState("error");
    }
  }

  if (state === "done") {
    return (
      // NOT "your invite is coming". There is no invite gate — the header's
      // sign-in link opens the product to anyone with a Bluesky account, and
      // telling a writer to wait for a door that is already open is the kind of
      // small dishonesty that costs more than the scarcity buys. What the list
      // is actually for is the founding cohort and the direct line, neither of
      // which needs access to be withheld to mean something.
      <p className="border-2 border-ink p-6 font-display font-semibold text-ink text-lg">
        You're on the list. You don't have to wait for us, though — sign in with
        Bluesky and start writing whenever you like.
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-3 border-2 border-ink p-6"
      onSubmit={submit}
    >
      <label
        className="basis-full font-bold font-display text-ink text-sm"
        htmlFor="email"
      >
        Email address
      </label>
      {/* Honeypot: humans never see it; bots that fill it get rejected. Named
          opaquely — Chrome autofills recognizable names (company, etc.) even
          when hidden, which would reject real signups (crbug 40223868). */}
      <input
        aria-hidden="true"
        autoComplete="off"
        className="absolute -left-[9999px] h-px w-px"
        id="gr_extra"
        name="gr_extra"
        tabIndex={-1}
        type="text"
      />
      <input
        className="min-h-11 min-w-56 flex-1 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
        id="email"
        inputMode="email"
        name="email"
        placeholder="you@example.com"
        required
        type="email"
      />
      <button
        className="min-h-11 cursor-pointer bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink disabled:opacity-60"
        disabled={state === "sending"}
        type="submit"
      >
        {state === "sending" ? "Joining…" : "Count me in"}
      </button>
      {/* Anti-bot challenge — renders only when the sitekey env var is set. */}
      <TurnstileWidget />
      <p className="basis-full font-display text-ink-soft text-xs leading-normal">
        One email when your invite is ready, occasional build notes in between —
        and yours to leave anytime with one click.
      </p>
      {state === "error" && (
        <p className="basis-full font-display text-sm text-spot" role="alert">
          That didn't go through — check the address and try again.
        </p>
      )}
      <p className="basis-full font-display text-ink-soft text-xs leading-relaxed">
        By joining you agree to our{" "}
        <a
          className="underline underline-offset-2 hover:text-ink"
          href="/terms"
        >
          Terms
        </a>{" "}
        and{" "}
        <a
          className="underline underline-offset-2 hover:text-ink"
          href="/privacy"
        >
          Privacy policy
        </a>
        .
      </p>
    </form>
  );
}

/**
 * Reads the search-param notice from the matched route, then hands off to the
 * pure `Landing` component — same split as ~/routes/write's SignIn: the
 * hook-dependent wrapper is the route's `component`, the exported piece stays
 * router-context-free and directly render-testable (see home.test.tsx).
 */
function LandingRoute() {
  const { notice } = Route.useSearch();
  return <Landing notice={notice} />;
}

export function Landing({ notice }: { notice?: "goodbye" } = {}) {
  return (
    <div className="goldroad-surface flex min-h-screen flex-col bg-paper font-body text-ink">
      <SiteHeader variant="marketing" />

      {/* Post-account-deletion goodbye: search-param-driven, same pattern as
          /settings and /dashboard's notices. Calm, not apologetic — deleting
          an account is a normal, supported action. */}
      {notice === "goodbye" && (
        <div className="mx-auto w-full max-w-5xl px-6 pt-6 md:px-16">
          <Notice>
            Your Goldroad account is gone — drafts, import history, and your
            sign-in all deleted. Anything you published stays exactly where it
            always lived: your own repo. Come back anytime.
          </Notice>
        </div>
      )}

      {/* Homepage speaks to Bluesky-native writers; /leaving-substack is the
          separate entry point for writers migrating from other platforms —
          never a blended hero. */}
      <main className="flex-1" id={MAIN_CONTENT_ID} tabIndex={-1}>
        {/* Hero — distribution-first message. landing_variant control renders
            below; the challenger lives in HERO_HEADLINES. */}
        <section className="relative">
          <RegMark className="absolute top-6 left-6 size-5 text-ink opacity-75" />
          <RegMark className="absolute top-6 right-6 size-5 text-ink opacity-75" />
          <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-16 md:px-16 md:pt-20 md:pb-24">
            <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
              <div>
                <Kicker>For writers already on Bluesky</Kicker>
                <h1 className="mt-5 max-w-[16ch] text-balance font-black font-display text-4xl text-ink leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
                  Your followers are already{" "}
                  <span className="spot-highlight">your readers</span>.
                </h1>
                {/* The card beside this paragraph already shows what a post
                    looks like in the timeline, so the sub doesn't describe it
                    again — it says what the writer does and what they keep.
                    The editor's features and the no-cold-start argument have
                    their own sections below; saying them here too made this
                    four lines of feature tour. */}
                <p className="mt-6 max-w-[46ch] text-pretty font-body text-ink-soft text-lg italic md:text-xl">
                  Write the long one here. It goes up on a page you own, and out
                  to the timelines of everyone who follows you.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <CtaLink href="#join">Join the founding writers</CtaLink>
                  <QuietLink href="#how">See how it works</QuietLink>
                </div>
                <p className="mt-8 max-w-[52ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
                  Free while we build · your followers stay yours · publishing
                  and Bluesky distribution stay free for good.
                </p>
              </div>
              <TimelineCard />
            </div>
          </div>
        </section>

        {/* How it works — the sequence is the information, so the steps are
            numbered (craft-floor). Plain outcomes, no press cosplay. */}
        <MarketingSection divider id="how">
          <Kicker>How it works</Kicker>
          <h2 className="mt-4 max-w-[22ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            From handle to publication in one sitting.
          </h2>
          <ol className="mt-10 grid grid-cols-1 border-2 border-ink lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li
                className="border-rule border-b p-6 last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0"
                key={step.title}
              >
                <span className="inline-grid size-11 place-items-center bg-ink font-black font-display text-2xl text-paper">
                  {i + 1}
                </span>
                <h3 className="mt-4 font-bold font-display text-ink text-lg">
                  {step.title}
                </h3>
                <p className="mt-2 text-ink-soft text-sm leading-normal">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </MarketingSection>

        {/* Distribution proof, in words — the no-cold-start argument. Editorial
            three-column rail (shared rules, aligned baselines, no boxes), led
            by one dominant claim; not a card grid. */}
        <MarketingSection divider>
          <Kicker>Why here</Kicker>
          <h2 className="mt-4 max-w-[16ch] text-balance font-black font-display text-3xl text-ink leading-[1.08] tracking-tight md:text-5xl">
            Your audience isn't a cold start.
          </h2>
          <p className="mt-5 max-w-[54ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Every other home for long-form asks you to rebuild your readership
            from scratch, somewhere new. Yours is already here — Goldroad is
            native to the network where your readers follow you.
          </p>
          <div className="mt-12 grid grid-cols-1 border-ink border-t-2 md:grid-cols-3">
            {REASONS.map((reason) => (
              <div
                className="border-rule border-b py-7 last:border-b-0 md:border-r md:border-b-0 md:px-9 md:py-8 md:last:border-r-0 md:last:pr-0 md:first:pl-0"
                key={reason.title}
              >
                <h3 className="font-bold font-display text-ink text-xl leading-snug tracking-tight">
                  {reason.title}
                </h3>
                <p className="mt-3 max-w-[34ch] text-ink-soft text-sm leading-relaxed">
                  {reason.body}
                </p>
              </div>
            ))}
          </div>
        </MarketingSection>

        {/* Ownership + economics — 0% and leave-anytime as trust facts,
            placed here rather than in the headline. */}
        <MarketingSection divider>
          <Kicker>What you own</Kicker>
          <h2 className="mt-4 max-w-[22ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Leaving is the guarantee.
          </h2>
          <p className="mt-4 max-w-[56ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Anyone can promise you own your work. Goldroad is built so the
            promise doesn't depend on us keeping it. If Goldroad vanished
            tonight, your publication wouldn't — here is exactly what stays
            yours, and why we couldn't hold it if we wanted to.
          </p>
          <dl className="mt-10 grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
            <div>
              <dt className="font-bold font-display text-ink text-lg">
                Your page and your archive
              </dt>
              <dd className="mt-2 text-ink-soft text-sm leading-relaxed">
                Every piece gets a fast public page, and the original is written
                to a data repo you control. Our servers keep a copy for speed;
                yours keeps the original.
              </dd>
            </div>
            <div>
              <dt className="font-bold font-display text-ink text-lg">
                Your readers
              </dt>
              <dd className="mt-2 text-ink-soft text-sm leading-relaxed">
                They follow your handle, not our app, so they stay yours on
                every app that speaks the same network. When the email list
                ships it starts portable: import it, export it, every address
                visibly yours.
              </dd>
            </div>
            <div>
              <dt className="font-bold font-display text-ink text-lg">
                Your identity
              </dt>
              <dd className="mt-2 text-ink-soft text-sm leading-relaxed">
                Your handle is your account — the exact name your readers
                already follow. Nothing to rebuild if you ever move on.
              </dd>
            </div>
            <div>
              <dt className="font-bold font-display text-ink text-lg">
                0% of what readers pay
              </dt>
              <dd className="mt-2 text-ink-soft text-sm leading-relaxed">
                When reader payments ship, readers will pay you directly and
                we'll take zero — permanently, not a launch promo. Substack
                takes 10%.
              </dd>
            </div>
          </dl>
          {/* The guarantee's proof. A claim about architecture is only worth
              what the reader can check, and the code is the check. */}
          <p className="mt-10 border-rule border-t pt-4 text-ink-soft text-sm">
            The code that keeps these promises is public —{" "}
            <a
              className="font-display font-semibold text-ink underline decoration-2 underline-offset-4 transition-colors hover:text-spot"
              href="/open"
            >
              read it
            </a>
            . Coming from Substack?{" "}
            <a
              className="font-display font-semibold text-ink underline decoration-2 underline-offset-4 transition-colors hover:text-spot"
              href="/leaving-substack"
            >
              See how the two compare, honestly →
            </a>
          </p>
        </MarketingSection>

        {/* Objection handling, immediately before the ask — the four questions a
            writer actually stops on. Answers are one sentence each and every one
            is checkable; a question we cannot answer honestly does not appear.
            Deliberately NOT a concession section: "is Bluesky big enough" is
            answered by reframing whose audience this is for, not by conceding a
            comparison we were not asked to make.

            A definition list rather than accordions: four short answers are
            faster to read than to click, and a disclosure widget on a landing
            page hides the reassurance it was added to provide. */}
        <MarketingSection divider>
          <Kicker>Before you ask</Kicker>
          <h2 className="mt-4 max-w-[22ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            The four questions we get.
          </h2>
          <dl className="mt-10 grid max-w-[70ch] grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">
            {[
              {
                q: "What does it cost?",
                a: "Publishing, your page and Bluesky distribution are free, and stay free. Paid plans will sell the things that cost us money — never a share of what your readers pay you.",
              },
              {
                q: "Is Bluesky big enough?",
                a: "Your followers are already there, and that is the point: this is built for the audience you have rather than one an algorithm might grant you.",
              },
              {
                q: "Can I use my own domain?",
                a: "Not yet — that one is genuinely on the roadmap. Every link we mint today keeps working when it lands, because your posts are addressed by your account rather than by our hostname.",
              },
              {
                q: "What if Goldroad disappears?",
                a: "Your posts are already in an account you control, and the code that runs this is public — so someone else can run it, including you.",
              },
            ].map(({ q, a }) => (
              <div key={q}>
                <dt className="font-bold font-display text-base text-ink">
                  {q}
                </dt>
                <dd className="mt-2 text-base text-ink-soft leading-relaxed">
                  {a}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-10 max-w-[56ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
            Something else?{" "}
            <a
              className="font-semibold text-ink underline decoration-2 underline-offset-4 transition-colors hover:text-spot"
              href="/open"
            >
              Read what's open
            </a>{" "}
            — the licence, the source, and how to run it yourself.
          </p>
        </MarketingSection>

        {/* Founding-writers signup — the page's conversion moment, so the
            structure carries the priority: three parallel goods, then the one
            number that makes the offer concrete, then the form. Ruled columns
            rather than cards — Pressroom separates with rules, and a grid of
            same-size cards is the lazy container. No new spot: the kicker and
            the submit button already spend this section's accent. */}
        <MarketingSection divider id="join">
          <Kicker>Founding writers</Kicker>
          <h2 className="mt-4 max-w-[22ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Be one of the founding writers.
          </h2>
          <p className="mt-4 max-w-[54ch] text-pretty text-ink-soft text-lg leading-relaxed">
            The core is live. Newsletters and reader payments are still being
            built.
          </p>
          {/* What "live" means, as a spec strip rather than a sentence: this is
              a list of seven facts, and prose was making the reader parse it
              like an argument. Display face and hairline separators mark it as
              inventory, which is also what makes it skimmable. */}
          <ul className="mt-5 flex max-w-[62ch] flex-wrap items-center gap-x-3 gap-y-2 font-display text-ink text-sm">
            {[
              "Drafts & autosave",
              "Images",
              "Footnotes",
              "Scheduling",
              "Your own colours",
              "Import from Substack, Ghost, Medium, WordPress",
              "Native Bluesky cards",
            ].map((item, i) => (
              <li className="flex items-center gap-3" key={item}>
                {i > 0 && (
                  <span aria-hidden="true" className="text-rule">
                    /
                  </span>
                )}
                {item}
              </li>
            ))}
          </ul>
          {/* The offer, in nameable goods rather than abstractions — and set as
              three equal columns because they ARE parallel and equal. Each is
              claimable today or is a promise we can keep forever. Deliberately
              NOT a held price: our costs scale with a writer's list, so a frozen
              rate would be a cheque against a number we do not know. */}
          <dl className="mt-12 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-3">
            {[
              {
                term: "A founding mark",
                detail:
                  "On your publication, yours to keep whatever we become.",
              },
              {
                term: "Newsletters and payments first",
                detail:
                  "And a direct line while the group is small enough for one.",
              },
              {
                term: "Free stays free — for you",
                detail:
                  "What works for you today keeps working, permanently. You are never moved onto a paid plan to keep what you already have.",
              },
            ].map(({ term, detail }) => (
              <div className="border-ink border-t-2 pt-4" key={term}>
                <dt className="font-bold font-display text-ink text-sm uppercase tracking-[0.08em]">
                  {term}
                </dt>
                <dd className="mt-2.5 text-ink-soft text-sm leading-relaxed">
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
          {/* The cap, as prose rather than a figure — and deliberately not the
              deliverability reason it started as.

              Three things were wrong with the earlier version. It led with OUR
              constraint (a sending domain earning reputation), which a writer
              has no reason to care about. It put the word "spam" one element
              above the signup form, naming a fear at the exact moment the page
              asks for trust — which is what the positive-framing rule exists to
              prevent. And it spent the big-figure treatment, which this system
              reserves for good news like the 0%, on a restriction.

              The number stays, because specificity persuades and it is true.
              What changed is which true reason we give: a group this size can
              be looked after, which is the part that is about the reader. */}
          <p className="mt-10 max-w-[56ch] text-pretty text-ink-soft text-lg leading-relaxed">
            We're starting with{" "}
            <strong className="font-display font-semibold text-ink">
              25 writers
            </strong>{" "}
            — small enough that setting you up is a conversation rather than a
            queue, and that the person answering your questions is the one
            building the thing.
          </p>
          <div className="mt-10 max-w-xl">
            <FoundingWritersForm />
          </div>
          {/* Pricing belongs near the decision, at footnote weight — it answers
              a question rather than making a pitch. */}
          <p className="mt-8 max-w-[56ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
            Publishing stays free for good. Paid plans will sell the things that
            cost us money — domains, email delivery, deeper analytics — never a
            share of what your readers pay you.
          </p>
        </MarketingSection>
      </main>

      <SiteFooter variant="marketing" />
    </div>
  );
}
