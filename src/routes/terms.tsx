import { createFileRoute } from "@tanstack/react-router";

import { LegalLayout, LegalList, LegalSection } from "~/components/legal-page";

/**
 * Terms of service (audit #2). DRAFT — owner/lawyer review before public
 * launch. Governing law is a placeholder (see PR OWNER ACTIONS).
 */
export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms — Goldroad" },
      {
        name: "description",
        content:
          "The terms for using Goldroad. Your content stays yours, in your own repo; the service is provided as-is.",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalLayout
      kicker="Goldroad · Terms"
      title="Terms of service"
      updated="27 July 2026"
      draft
    >
      <LegalSection heading="The short version">
        <p>
          Use Goldroad to publish your own work to your own account on the open
          network. Your content stays yours. Follow the acceptable-use rules.
          The service is provided as-is while we build it. You can leave any
          time and take everything with you.
        </p>
      </LegalSection>

      <LegalSection heading="Your content is yours">
        <p>
          Everything you publish through Goldroad is written to your own atproto
          data repository (your PDS), under your own identity. You own it. By
          using Goldroad, you give us permission to fetch, render, and display
          that content — and to proxy its images through our site — so your
          pages work. That permission ends when you remove the content or
          disconnect your account; there's nothing for us to keep.
        </p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <p>
          Don't use Goldroad for anything illegal or abusive. The specifics, and
          how takedowns and reports work, are in our{" "}
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="/policies"
          >
            content policies
          </a>
          , which form part of these terms.
        </p>
      </LegalSection>

      <LegalSection heading="Your account">
        <p>
          You sign in with your own Bluesky / atproto account. You're
          responsible for keeping that account secure and for what's published
          under it. We authenticate you through your own server — we never hold
          your password.
        </p>
      </LegalSection>

      <LegalSection heading="Availability & 'as is'">
        <LegalList
          items={[
            'Goldroad is provided "as is" and "as available", without warranties of any kind.',
            "We're pre-launch and run on free infrastructure — we don't guarantee uptime, and features can change.",
            "To the extent the law allows, Goldroad isn't liable for indirect or consequential losses arising from use of the service.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="Stopping service">
        <p>
          We may stop serving specific content, or suspend access, when the{" "}
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="/policies"
          >
            content policies
          </a>{" "}
          require it. Because your content lives in your own repo, this removes
          it from our site but not from the wider network — and you keep it
          regardless.
        </p>
      </LegalSection>

      <LegalSection heading="Governing law">
        <p>
          These terms are governed by the laws of the jurisdiction of Goldroad's
          operator (to be confirmed before public launch). Nothing here removes
          rights you have under mandatory local consumer or data-protection law.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          We'll update the date above when these terms change, and flag material
          changes to signed-in writers.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
