import { createFileRoute } from "@tanstack/react-router";

import { ExternalLink } from "~/components/external-link";
import { CtaLink, MarketingSection, RegMark } from "~/components/marketing";
import { OPEN_LINKS, SiteFooter, SiteHeader } from "~/components/site-chrome";
import { CANONICAL_ORIGIN } from "~/lib/origin";

/**
 * /open — the trust surface. Goldroad's central promise is that it can't be
 * taken away, and until this page existed a visitor had no way to check that:
 * "open source" appeared nowhere on the site and no link reached the source.
 *
 * Written for the two audiences who arrive asking the same question in
 * different words — a developer following a link from the network, and a
 * public-interest reviewer deciding whether the claim holds. So it names the
 * licence, the contribution terms, the standards, the self-hosting path and
 * the business model, and it marks what isn't built rather than rounding up.
 *
 * Marketing register (Goldroad is speaking), but deliberately the quietest
 * marketing surface we have: one accent moment, which is the link to the
 * source. A badge wall would undercut the thing the page is claiming.
 */
export const Route = createFileRoute("/open")({
  head: () => ({
    meta: [
      { title: "Open source — Goldroad" },
      {
        name: "description",
        content:
          "Goldroad's server is open source under AGPL-3.0-only: read it, run it, or fork it. Contributions are DCO with no CLA, so the core can never be relicensed away from the commons.",
      },
      { property: "og:title", content: "Open source — Goldroad" },
      {
        property: "og:description",
        content:
          "The code that runs Goldroad is public under AGPL-3.0-only. DCO, no CLA, no relicensing. Built on the AT Protocol with the shared standard.site records.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${CANONICAL_ORIGIN}/open` },
    ],
    links: [{ rel: "canonical", href: `${CANONICAL_ORIGIN}/open` }],
  }),
  component: OpenPage,
});

const ISSUES_URL = `${OPEN_LINKS.repo}/issues`;
const SECURITY_URL = `${OPEN_LINKS.repo}/blob/main/SECURITY.md`;

/** Section eyebrow in ink, not the spot-colored `Kicker`: this page spends its
 * single accent on the link to the source and nowhere else. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-4 max-w-[24ch] text-balance font-black font-display text-3xl text-ink leading-tight tracking-tight md:text-4xl">
      {children}
    </h2>
  );
}

const PROSE =
  "mt-4 max-w-[58ch] text-pretty text-ink-soft text-lg leading-relaxed";
const INLINE_LINK =
  "underline underline-offset-2 transition-colors hover:text-ink";

export function OpenPage() {
  return (
    <div className="goldroad-surface flex min-h-screen flex-col bg-paper font-body text-ink">
      <SiteHeader variant="marketing" />

      <main className="flex-1">
        <section className="relative">
          <RegMark className="absolute top-6 left-6 size-5 text-ink opacity-75" />
          <RegMark className="absolute top-6 right-6 size-5 text-ink opacity-75" />
          <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-16 md:px-16 md:pt-20 md:pb-20">
            <SectionLabel>Open source</SectionLabel>
            <h1 className="mt-5 max-w-[18ch] text-balance font-black font-display text-4xl text-ink leading-[1.05] tracking-tight md:text-6xl">
              Your writing is yours. So is the software.
            </h1>
            <p className="mt-6 max-w-[54ch] text-pretty font-body text-ink-soft text-lg italic md:text-xl">
              Goldroad publishes your work into an account you own on the open
              network, and the code that does it is public under a licence
              designed to keep it public. Every promise on this site is
              something you can read for yourself, run yourself, or fork.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CtaLink
                href={OPEN_LINKS.repo}
                rel="noopener noreferrer"
                target="_blank"
              >
                Read the source on GitHub
                <span className="sr-only"> (opens in new tab)</span>
              </CtaLink>
              <ExternalLink
                className="inline-flex min-h-11 items-center font-display font-semibold text-ink text-sm underline decoration-2 underline-offset-4 transition-colors hover:text-spot"
                href={OPEN_LINKS.license}
              >
                Read the licence
              </ExternalLink>
            </div>
            <p className="mt-8 max-w-[56ch] border-rule border-t pt-4 font-display text-ink-soft text-sm leading-normal">
              AGPL-3.0-only · contributions by DCO, no CLA · built on the AT
              Protocol.
            </p>
          </div>
        </section>

        <MarketingSection divider>
          <SectionLabel>The licence</SectionLabel>
          <SectionHeading>What AGPL-3.0 gives you.</SectionHeading>
          <p className={PROSE}>
            The server is licensed{" "}
            <ExternalLink className={INLINE_LINK} href={OPEN_LINKS.license}>
              AGPL-3.0-only
            </ExternalLink>{" "}
            — the whole of it, not a hollowed-out core with the useful parts
            held back. Three things follow, and you can hold us to all three.
          </p>
          <ul className="mt-6 max-w-[58ch] space-y-4 text-ink-soft text-lg leading-relaxed">
            <li className="border-rule border-l-2 pl-4">
              <strong className="font-bold font-display text-base text-ink uppercase tracking-[0.06em]">
                Read it
              </strong>
              <span className="mt-1 block">
                Every line that touches your writing is published, including the
                parts that handle your identity and your drafts.
              </span>
            </li>
            <li className="border-rule border-l-2 pl-4">
              <strong className="font-bold font-display text-base text-ink uppercase tracking-[0.06em]">
                Run it
              </strong>
              <span className="mt-1 block">
                On your own domain, under your own account, without asking
                anyone.
              </span>
            </li>
            <li className="border-rule border-l-2 pl-4">
              <strong className="font-bold font-display text-base text-ink uppercase tracking-[0.06em]">
                Get the source of what's running
              </strong>
              <span className="mt-1 block">
                Anyone who runs Goldroad as a service for other people — us
                included — owes those people the source of the exact version
                they're using. That network clause is why the licence is a
                copyleft one and not a permissive one.
              </span>
            </li>
          </ul>
          <p className={PROSE}>
            If this project is sold, abandoned, or turns into something you want
            no part of, the software is already out of our hands and in yours.
            That is the whole reason for choosing this licence.
          </p>
        </MarketingSection>

        <MarketingSection divider>
          <SectionLabel>Contributions</SectionLabel>
          <SectionHeading>DCO, no CLA, no relicensing.</SectionHeading>
          <p className={PROSE}>
            Contributors sign off on the{" "}
            <ExternalLink
              className={INLINE_LINK}
              href="https://developercertificate.org/"
            >
              Developer Certificate of Origin
            </ExternalLink>{" "}
            — one line certifying they wrote the patch and may submit it under
            the project's licence. There is no contributor licence agreement,
            and there will not be one.
          </p>
          <p className={PROSE}>
            The difference is the whole ballgame. A CLA gathers up the rights
            that let a single company relicense a project later, after the
            contributions have arrived. Without one, no party — the maintainers
            included — holds enough of the copyright to take the core
            proprietary. It stays in the commons structurally, not because
            anyone promised to be good.{" "}
            <ExternalLink
              className={INLINE_LINK}
              href={OPEN_LINKS.contributing}
            >
              How to contribute
            </ExternalLink>
            .
          </p>
        </MarketingSection>

        <MarketingSection divider>
          <SectionLabel>Standards</SectionLabel>
          <SectionHeading>Built on shared formats, not ours.</SectionHeading>
          <p className={PROSE}>
            Goldroad runs on the{" "}
            <ExternalLink className={INLINE_LINK} href={OPEN_LINKS.atproto}>
              AT Protocol
            </ExternalLink>
            , the open network behind Bluesky. Your identity, your followers and
            your published posts live in your account there — not in our
            database. Signing out of Goldroad forever leaves all of it exactly
            where it was.
          </p>
          <p className={PROSE}>
            Your posts are written as{" "}
            <ExternalLink className={INLINE_LINK} href="https://standard.site">
              standard.site
            </ExternalLink>{" "}
            documents — a format defined by the Leaflet, pckt.blog and Offprint
            teams rather than invented here, so other software on the network
            can read what you publish through us. It runs both ways: Goldroad's
            reading pages render any author's standard.site posts, including
            authors who have never heard of us.
          </p>
          <p className={PROSE}>
            We have not needed a format of our own yet, and we won't add one
            where the shared one works. If that day comes, it ships as CC0 —
            public domain, on the same terms as the vocabulary we borrowed.
          </p>
        </MarketingSection>

        <MarketingSection divider>
          <SectionLabel>Self-hosting</SectionLabel>
          <SectionHeading>You can run your own copy.</SectionHeading>
          <p className={PROSE}>
            The deploy path is written down:{" "}
            <ExternalLink className={INLINE_LINK} href={OPEN_LINKS.selfHosting}>
              SELF_HOSTING.md
            </ExternalLink>{" "}
            walks through Cloudflare Workers, a D1 database, your own OAuth
            client and your own domain.
          </p>
          <p className={PROSE}>
            Honestly, though: the hosted service is the version we support.
            Self-hosting works and is documented, but it's community-supported —
            no upgrade tooling, no migration help. Being able to leave is the
            promise that's kept today; a self-hosting story polished enough to
            recommend is on the roadmap, not shipped.
          </p>
        </MarketingSection>

        <MarketingSection divider>
          <SectionLabel>The money</SectionLabel>
          <SectionHeading>Who pays, and for what.</SectionHeading>
          <p className={PROSE}>
            Open source doesn't cover hosting bills, so here is the model in
            full. We take 0% of what readers pay writers, permanently. Paid
            plans will sell the things that cost us money — custom domains,
            email delivery, richer analytics — because those are real expenses
            with a real margin.
          </p>
          <p className={PROSE}>
            Reader payments aren't built yet. When they are, they run through
            the writer's own payment processor, so the money goes from reader to
            writer without passing through us. Publishing, a hosted publication
            and distribution to Bluesky stay free, permanently.
          </p>
        </MarketingSection>

        <MarketingSection divider>
          <SectionLabel>Everything else</SectionLabel>
          <SectionHeading>Come and look.</SectionHeading>
          <p className={PROSE}>
            The repository is the whole project: the code that serves this page,
            the tests, the migrations, and the documents that say what is and
            isn't built.
          </p>
          <nav
            aria-label="Project links"
            className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-display text-ink-soft text-sm"
          >
            <ExternalLink className={INLINE_LINK} href={OPEN_LINKS.repo}>
              Source on GitHub
            </ExternalLink>
            <ExternalLink className={INLINE_LINK} href={ISSUES_URL}>
              Report a bug or ask a question
            </ExternalLink>
            <ExternalLink className={INLINE_LINK} href={SECURITY_URL}>
              Security policy
            </ExternalLink>
            <a className={INLINE_LINK} href="/#join">
              Join the founding writers
            </a>
          </nav>
        </MarketingSection>
      </main>

      <SiteFooter variant="marketing" />
    </div>
  );
}
