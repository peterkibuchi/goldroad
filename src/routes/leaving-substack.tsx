import { createFileRoute } from "@tanstack/react-router";

import {
  CtaLink,
  Kicker,
  MarketingSection,
  QuietLink,
  RegMark,
} from "~/components/marketing";
import { SiteFooter, SiteHeader } from "~/components/site-chrome";
import { CANONICAL_ORIGIN } from "~/lib/origin";

export const Route = createFileRoute("/leaving-substack")({
  head: () => ({
    meta: [
      { title: "Leaving Substack — Goldroad" },
      {
        name: "description",
        content:
          "Bring your readers, your subscriber list, and — once reader payments ship — the Stripe account your paying subscribers already pay into. 0% taken where Substack takes 10%. An honest look at how Goldroad compares, roadmap and all.",
      },
      { property: "og:title", content: "Leaving Substack — Goldroad" },
      {
        property: "og:description",
        content:
          "Own your publication, your list, and your revenue on the open network. See how Goldroad compares to Substack — honestly, roadmap status included.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${CANONICAL_ORIGIN}/leaving-substack` },
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
    goldroad: "Yours; export any day",
    substack: "Yours to export; Substack's by default",
  },
  {
    label: "Where readers find you",
    goldroad: "Native cards in the Bluesky timeline",
    substack: "Substack's app and recommendations",
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
    label: "Import your archive",
    goldroad:
      "Upload your Substack, Medium, Ghost, or WordPress export — or paste any feed — your archive arrives as private drafts",
    substack: "—",
  },
];

/** Honest "not shipped yet" marker for roadmap rows — no vaporware. */
function RoadmapTag() {
  return (
    <span className="mt-1 inline-block border border-ink-soft px-1.5 py-0.5 font-display font-semibold text-[0.65rem] text-ink-soft uppercase tracking-[0.08em]">
      On the roadmap
    </span>
  );
}

function ComparisonTable() {
  const cell = "border-rule border-b p-3 align-top";
  const head =
    "border-ink border-b-2 p-3 font-bold font-display text-xs uppercase tracking-[0.08em]";
  return (
    <div className="mt-10 overflow-x-auto">
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
                {row.goldroad}
                {row.roadmap && (
                  <>
                    <br />
                    <RoadmapTag />
                  </>
                )}
              </td>
              <td className={`${cell} text-ink-soft`}>{row.substack}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeavingSubstack() {
  return (
    <div className="flex min-h-screen flex-col bg-paper font-body text-ink">
      <SiteHeader variant="marketing" />

      <main className="flex-1">
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
              writing on a page you own, and your subscriber list in your hands.
              Once reader payments ship, the readers already paying you keep
              paying — through the same Stripe account they use today. Substack
              takes 10% of what readers pay you; we take 0%.
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
          <ComparisonTable />
          <figure className="mt-12 border-ink border-l-2 pl-5">
            <p className="font-black font-display text-5xl text-ink md:text-6xl">
              0%
            </p>
            <figcaption className="mt-3 max-w-[52ch] text-ink-soft text-sm leading-relaxed">
              of what your readers pay you — a permanent policy, not a
              promotion. Substack takes 10%. On a publication earning $50,000 a
              year, that's about $5,000 a year that stays yours. (Illustrative;
              your numbers are your own.)
            </figcaption>
          </figure>
        </MarketingSection>

        {/* Mirror mode — shipped: import + provenance back to the original. */}
        <MarketingSection divider>
          <Kicker>Here now</Kicker>
          <h2 className="mt-4 max-w-[22ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
            Keep publishing on Substack, too.
          </h2>
          <p className="mt-4 max-w-[60ch] text-pretty text-ink-soft text-lg leading-relaxed">
            Import brings your archive here as drafts while the originals stay
            exactly where they are. Readers keep landing on your Substack until
            you decide otherwise, so you can move at whatever pace suits you —
            one post, or all of them.
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
            account to Goldroad, and the readers already paying you keep paying:
            same cards, same schedule, nothing for them to sign up for again.
            The 10% stays with you instead.
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
            Substack import is live — your archive can come across today.
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
