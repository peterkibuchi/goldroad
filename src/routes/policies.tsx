import { createFileRoute } from "@tanstack/react-router";

import { ExternalLink } from "~/components/external-link";
import { LegalLayout, LegalList, LegalSection } from "~/components/legal-page";

/**
 * Acceptable-use + takedown policy (moderation kit, audit #1). Plain, outcome-
 * first copy. abuse@trygoldroad.com is a placeholder until the owner wires the
 * mailbox (see PR OWNER ACTIONS).
 */
export const Route = createFileRoute("/policies")({
  head: () => ({
    meta: [
      { title: "Content policies — Goldroad" },
      {
        name: "description",
        content:
          "What's allowed on Goldroad, how to report content, and how takedowns work.",
      },
    ],
  }),
  component: PoliciesPage,
});

const abuse = (
  <ExternalLink
    className="underline underline-offset-2 transition-colors hover:text-ink"
    href="mailto:abuse@trygoldroad.com"
  >
    abuse@trygoldroad.com
  </ExternalLink>
);

function PoliciesPage() {
  return (
    <LegalLayout kicker="Goldroad · Policies" title="Content policies">
      <LegalSection heading="What Goldroad hosts">
        <p>
          Goldroad helps writers publish to their own accounts on the AT
          Protocol and renders that writing at trygoldroad.com. The words and
          images belong to their authors and live in their own data repos on the
          open network — we display them and proxy their images. That makes us a
          host, so these rules cover what we will and won't keep serving from
          our site.
        </p>
      </LegalSection>

      <LegalSection heading="What isn't allowed">
        <p>Don't use Goldroad to publish or promote:</p>
        <LegalList
          items={[
            "Anything illegal, or content that sexually exploits or endangers children.",
            "Material you don't have the rights to — copyright or trademark infringement.",
            "Malware, phishing, or attempts to defraud or deceive readers.",
            "Targeted harassment, threats of violence, or incitement to harm.",
            "Doxxing — publishing someone's private information without consent.",
            "Spam, or automated abuse of the service.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="How to report something">
        <p>
          If a page here breaks these rules, use the{" "}
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="/report"
          >
            report form
          </a>{" "}
          (there's a "Report" link at the foot of every published page) or email{" "}
          {abuse}. Tell us the URL and what's wrong. A human reviews every
          report.
        </p>
      </LegalSection>

      <LegalSection heading="Takedowns">
        <p>
          When a report is valid, we stop serving the page and its images from
          trygoldroad.com. Because the underlying record lives in the author's
          own repo, that removes it from our site but not from the wider network
          — the author, their hosting provider (PDS), or a network-level
          moderation service controls the record itself.
        </p>
        <p>
          We may act without prior notice where the law requires it or where
          content is clearly harmful, and we'll restore content if a takedown
          turns out to be mistaken.
        </p>
      </LegalSection>

      <LegalSection heading="Copyright / DMCA">
        <p>
          To report copyright infringement, email {abuse} with the URL, a
          description of the work you own, and a statement that you have a
          good-faith belief the use isn't authorized. We remove infringing
          material we host and handle repeat infringers accordingly.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>Abuse, takedown, and legal notices: {abuse}.</p>
      </LegalSection>
    </LegalLayout>
  );
}
