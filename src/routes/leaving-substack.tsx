import { createFileRoute } from "@tanstack/react-router";

import {
  CtaLink,
  Kicker,
  MarketingSection,
  QuietLink,
  RegMark,
} from "~/components/marketing";
import { SiteFooter, SiteHeader } from "~/components/site-chrome";
import { MAIN_CONTENT_ID } from "~/components/skip-link";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { DEFAULT_CARD_META } from "~/lib/social-card";

export const Route = createFileRoute("/leaving-substack")({
  head: () => ({
    meta: [
      { title: "Leaving Substack — Goldroad" },
      {
        name: "description",
        content:
          "Bring your archive today, and — once the list and reader payments ship — your subscribers and the Stripe account they already pay into. 0% taken where Substack takes 10%. An honest look at how Goldroad compares, roadmap and all.",
      },
      { property: "og:title", content: "Leaving Substack — Goldroad" },
      {
        property: "og:description",
        content:
          "Own your publication, your list, and your revenue on the open network. See how Goldroad compares to Substack — honestly, roadmap status included.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${CANONICAL_ORIGIN}/leaving-substack` },
      // This page shows the default card, so this page describes it.
      ...DEFAULT_CARD_META,
    ],
    links: [{ rel: "canonical", href: `${CANONICAL_ORIGIN}/leaving-substack` }],
  }),
  component: LeavingSubstack,
});

type Row = {
  label: string;
  goldroad: string;
  substack: string;
  /** Honest status: the Goldroad capability is on the roadmap, not shipped. */
  roadmap?: boolean;
};

const ROWS: Row[] = [
  {
    label: "Our cut of your reader revenue",
    goldroad: "0%, always",
    substack: "10%",
  },
  {
    label: "Your subscriber list",
    goldroad: "Yours — import it, add to it, export it any day",
    substack: "Yours to export; Substack's by default",
    roadmap: true,
  },
  {
    label: "Where readers find you",
    goldroad: "Enhanced cards in the Bluesky timeline",
    substack: "Substack's app and recommendations",
  },
  {
    label: "Ads in your newsletter",
    goldroad: "None, however big this gets",
    substack: "Opt-in sponsorships (bestseller tier), since June 2026",
  },
  {
    label: "Your comment section",
    goldroad: "A Bluesky thread — public, and it travels",
    substack: "Comments inside Substack",
  },
  {
    label: "Your identity",
    goldroad: "Your own handle, portable across the network",
    substack: "A Substack account",
  },
  {
    label: "Where your posts live",
    goldroad: "A data repo you control",
    substack: "Substack's servers",
  },
  {
    label: "The software",
    goldroad: "Open source (AGPL) — self-host if you ever want to",
    substack: "Closed",
  },
  {
    label: "Newsletters",
    goldroad: "Email your list from your own domain",
    substack: "Yes",
    roadmap: true,
  },
  {
    label: "Reader payments",
    goldroad:
      "The same Stripe account your Substack subscribers already pay into — they keep paying, and 0% is taken",
    substack: "Yes, minus 10%",
    roadmap: true,
  },
  {
    label: "Your archive when you leave",
    goldroad:
      "Full export — posts, account and all — and the originals were never ours to hold",
    substack: "Export file only; images not included",
  },
  {
    label: "Feeds",
    goldroad: "RSS for every publication, on by default",
    substack: "Free posts in full; paid posts as a preview",
  },
  {
    label: "The look of your page",
    goldroad:
      "A theme that travels with your account, honoured by apps we didn't write",
    substack: "Substack's template",
  },
  {
    label: "Import your archive",
    goldroad:
      "Upload your Substack, Medium, Ghost, or WordPress export — or paste any feed — your archive arrives as private drafts",
    substack: "—",
  },
];

/** Honest "not shipped yet" marker for roadmap rows — no vaporware. Sized to
 * the chrome's chip floor (11.2px); 10.4px uppercase was under it. */
function RoadmapTag() {
  return (
    <span className="mt-1 inline-block border border-ink-soft px-1.5 py-0.5 font-display font-semibold text-[0.7rem] text-ink-soft uppercase tracking-[0.08em]">
      On the roadmap
    </span>
  );
}

/** The Goldroad side of a row, tag and all — one definition, so the table and
 * the stacked list can never disagree about which capabilities are shipped. */
function GoldroadValue({ row }: { row: Row }) {
  return (
    <>
      {row.goldroad}
      {row.roadmap && (
        <>
          <br />
          <RoadmapTag />
        </>
      )}
    </>
  );
}

function ComparisonTable() {
  const cell = "border-rule border-b p-3 align-top";
  const head =
    "border-ink border-b-2 p-3 font-bold font-display text-xs uppercase tracking-[0.08em]";
  return (
    // The scroller — not just the table — is what hides below 640px: it carries
    // the top margin, so leaving it in place with an invisible table inside
    // would open 40px of dead space above the stacked list.
    <div className="mt-10 hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[36rem] border-collapse border-2 border-ink text-left text-sm">
        <caption className="sr-only">
          Goldroad and Substack compared, line by line.
        </caption>
        <thead>
          <tr>
            <th className={`${head} text-ink-soft`} scope="col">
              What matters
            </th>
            <th className={`${head} text-spot`} scope="col">
              Goldroad
            </th>
            <th className={`${head} text-ink-soft`} scope="col">
              Substack
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label}>
              <th
                className={`${cell} font-display font-semibold text-ink`}
                scope="row"
              >
                {row.label}
              </th>
              <td className={`${cell} text-ink`}>
                <GoldroadValue row={row} />
              </td>
              <td className={`${cell} text-ink-soft`}>{row.substack}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The same comparison, stacked, below 640px.
 *
 * A 576px table in a 272px window showed 47% of itself: the whole Substack
 * column sat off-screen, the header didn't stick, and nothing on screen said
 * there was more to the right. On the page whose entire argument IS the
 * comparison, half the argument was missing. Same rows, one block each — the
 * pattern `PostTable` already uses for the stats grid.
 *
 * The side labels stay ink. Twelve vermillion "Goldroad" markers would spend
 * the page's one accent twelve times over, so the two sides are told apart by
 * weight and colour depth, the way the table's own cells already are.
 */
function ComparisonList() {
  const side =
    "font-bold font-display text-ink-soft text-xs uppercase tracking-[0.08em]";
  return (
    <dl
      // The table's caption below 640px, where the table itself is gone.
      aria-label="Goldroad and Substack compared, line by line."
      className="mt-10 border-ink border-t-2 sm:hidden"
    >
      {ROWS.map((row) => (
        <div className="border-rule border-b py-4" key={row.label}>
          <dt className="font-bold font-display text-ink text-sm">
            {row.label}
          </dt>
          <dd className="mt-2.5 text-ink text-sm">
            <span className={`block ${side}`}>Goldroad</span>
            <GoldroadValue row={row} />
          </dd>
          <dd className="mt-2.5 text-ink-soft text-sm">
            <span className={`block ${side}`}>Substack</span>
            {row.substack}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Comparison() {
  return (
    <>
      <ComparisonTable />
      <ComparisonList />
    </>
  );
}

export function LeavingSubstack() {
  return (
    <div className="goldroad-surface flex min-h-screen flex-col bg-paper font-body text-ink">
      <SiteHeader variant="marketing" />

      <main className="flex-1" id={MAIN_CONTENT_ID} tabIndex={-1}>
        {/* Entry point for writers migrating from other platforms: economics
            and ownership lead here, where the homepage leads with
            distribution. Substack's lock-in is the foil — never a sideways
            punch at Atmosphere neighbors. */}
        <section className="relative">
          <RegMark className="absolute top-6 left-6 size-5 text-ink opacity-75" />
          <RegMark className="absolute top-6 right-6 size-5 text-ink opacity-75" />
          <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-16 md:px-16 md:pt-20 md:pb-20">
            <Kicker>Coming from Substack?</Kicker>
            <h1 className="mt-5 max-w-[18ch] text-balance font-black font-display text-4xl text-ink leading-[1.05] tracking-tight md:text-6xl">
              Bring your readers.{" "}
              <span className="spot-highlight">Keep the 10%</span> Substack
              takes.
            </h1>
            <p className="mt-6 max-w-[54ch] text-pretty font-body text-ink-soft text-lg italic md:text-xl">
              Goldroad is writer-owned publishing on the open network: your
              writing on a page you own, and your archive here today. Once the
              list and reader payments ship, the readers already paying you keep
              paying — through the same Stripe account they use today. Substack
              takes 10% of what readers pay you. Ours will always be 0%.
            </p>
            {/* The contrast that did not exist when this page was written. In
                June 2026 Substack began selling sponsorships into newsletters —
                opt-in, bestsellers first, no cut during the pilot. Stated as
                the fact it is rather than as an accusation: the argument is
                stronger when the reader draws the conclusion, and overstating
                a competitor is how a comparison page loses its credibility. */}
            <p className="mt-5 max-w-[54ch] text-pretty font-body text-ink-soft text-lg md:text-xl">
              In June 2026 Substack started selling sponsorships into writers'
              newsletters. We won't, however big this gets. What your readers
              get from us is your writing, and nothing else in the envelope.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CtaLink href="/#join">Join the founding writers</CtaLink>
              <QuietLink href="/#how">See how Goldroad works</QuietLink>
            </div>
            <p className="mt-8 max-w-[56ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
              Open and early · your Substack stays yours until you say otherwise
              · export anytime.
            </p>
          </div>
        </section>

        {/* The honest comparison */}
        <MarketingSection divider>
          <Kicker>The honest comparison</Kicker>
          <h2 className="mt-4 max-w-[24ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Goldroad and Substack, line by line.
          </h2>
          <p className="mt-4 max-w-[58ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Some of this is built and working today. Some of it isn't yet, and
            those rows say so — they're the ones worth reading closely.
          </p>
          <Comparison />
          <p className="mt-8 max-w-[58ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
            Every row above is either something you can test today or something
            marked as not built yet — and the code behind both is public.{" "}
            <a
              className="font-semibold text-ink underline decoration-2 underline-offset-4 transition-colors hover:text-spot"
              href="/open"
            >
              Read what's open
            </a>
            .
          </p>
          <figure className="mt-12 border-ink border-l-2 pl-5">
            <p className="font-black font-display text-5xl text-ink md:text-6xl">
              0%
            </p>
            {/* The only place on the site carrying arithmetic, so it is the
                place a "$5,000 = payments are free" misread is most expensive.
                Naming the processing fee strengthens the comparison rather than
                softening it: the 10% sits on top of Stripe's fee, which is
                Substack's own description of it, and every writer who has been
                paid through Substack has already seen both on a statement.
                Stripe by name here — this reader holds that account.

                Two paragraphs rather than one run: appended to the arithmetic
                it made an eight-line block of 14px text and the correction
                landed in the middle of it, which is where fine print goes to be
                skipped. Its own beat reads as candour instead. */}
            <figcaption className="mt-3 max-w-[52ch] text-ink-soft text-sm leading-relaxed">
              <span className="block">
                of what your readers pay you — a permanent policy, not a
                promotion. Substack takes 10%. On a publication earning $50,000
                a year, that's about $5,000 a year that stays yours.
              </span>
              <span className="mt-3 block">
                Stripe's processing fee applies either way, and Substack's 10%
                is charged on top of it. Their standard US domestic-card rate is
                about 2.9% + 30¢ a charge; other payment methods, currencies and
                countries price differently. So the $5,000 is the difference
                between two platforms, not a claim that payments are free.
                (Illustrative; your numbers are your own.)
              </span>
            </figcaption>
          </figure>
        </MarketingSection>

        {/* THE EMPHASIS INVERSION. The page used to run table → roadmap, which
            put what we cannot do yet ahead of everything we can. This section
            goes first because it is the only part a reader can verify today,
            and each row names a mechanism rather than a benefit — a claim you
            can check is worth more than one you have to believe. Ruled columns,
            no cards. */}
        <MarketingSection divider>
          <Kicker>Here today</Kicker>
          <h2 className="mt-4 max-w-[24ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            What's already true, and checkable.
          </h2>
          <p className="mt-4 max-w-[58ch] text-pretty text-ink-soft text-lg leading-relaxed">
            None of this is on a roadmap. It works now, and every line names how
            — so you can test it before you trust it.
          </p>
          <dl className="mt-12 grid grid-cols-1 gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                term: "Your whole archive, in minutes",
                detail:
                  "Substack, Ghost, Medium and WordPress exports, or any feed. The file is parsed on your machine and never reaches us; posts arrive as private drafts.",
              },
              {
                term: "Images that survive the move",
                detail:
                  "Body images are copied out of your old host into an account you own, so closing that account later costs your archive nothing.",
              },
              {
                term: "Footnotes that look like footnotes",
                detail:
                  "Set below a rule in their own type, linked both ways — for the pieces that carry citations.",
              },
              {
                term: "Publish on a schedule",
                detail:
                  "Pick the moment; it goes out without you. If anything stops it, the reason is written where you'll see it rather than swallowed.",
              },
              {
                term: "A feed for every publication",
                detail:
                  "An RSS twin of your archive, on by default — for the readers who follow by feed.",
              },
              {
                term: "Your colours, everywhere",
                detail:
                  "A theme stored in your own account, so other apps on the network render your page in it too.",
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
          <p className="mt-10 max-w-[56ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
            Bring the archive today. Bring the list when the machinery's ready.
          </p>
        </MarketingSection>

        {/* Mirror mode — shipped: import + provenance back to the original. */}
        <MarketingSection divider>
          <Kicker>At your own pace</Kicker>
          <h2 className="mt-4 max-w-[22ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Keep publishing on Substack, too.
          </h2>
          <p className="mt-4 max-w-[60ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Import brings your archive here as drafts while the originals stay
            exactly where they are. Readers keep landing on your Substack until
            you decide otherwise, so you can move at whatever pace suits you —
            one post, or all of them.
          </p>
          <p className="mt-4 max-w-[60ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Your images come across too — copied out of Substack's servers into
            an account you own — so closing your Substack later costs your
            archive nothing. The export file itself is read on your machine; it
            never reaches us.
          </p>
        </MarketingSection>

        {/* Payments portability — the hardest part of leaving Substack is the
            paying subscribers, and they're portable because the Stripe account
            is already the writer's. Strictly future-tense: reader payments are
            not shipped, and the kicker plus the closing line say so. */}
        <MarketingSection divider>
          <Kicker>On the roadmap</Kicker>
          <h2 className="mt-4 max-w-[24ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Your paying subscribers will come with you.
          </h2>
          <p className="mt-4 max-w-[60ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Substack charges your paid subscriptions through Stripe, and that
            Stripe account is yours — it holds your subscribers and their
            payment methods. When reader payments ship, you'll connect that same
            account to Goldroad. The readers already paying you keep paying:
            same cards, same schedule, and nothing to sign up for again. The 10%
            stays with you instead.
          </p>
          <p className="mt-8 max-w-[56ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
            Reader payments are still being built — this is the plan for when
            they ship, not today's product.
          </p>
        </MarketingSection>

        {/* CTA — founding-writers list on the homepage; honest about timing. */}
        <MarketingSection divider>
          <Kicker>Founding writers</Kicker>
          <h2 className="mt-4 max-w-[26ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Move when the machinery's ready — not before.
          </h2>
          <p className="mt-4 max-w-[58ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Substack import is live. Your archive can come across today.
            Newsletters and reader payments are still being hardened before we
            ask anyone whose income depends on them to switch. Join the founding
            writers and we'll bring you in the moment it's solid.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <CtaLink href="/#join">Join the founding writers</CtaLink>
            <QuietLink href="/">Back to the homepage</QuietLink>
          </div>
        </MarketingSection>
      </main>

      <SiteFooter variant="marketing" />
    </div>
  );
}
