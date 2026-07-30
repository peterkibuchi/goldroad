import { createFileRoute } from "@tanstack/react-router";

import { ExternalLink } from "~/components/external-link";
import { LegalLayout, LegalList, LegalSection } from "~/components/legal-page";

/**
 * Privacy policy (audit #2). DRAFT — owner/lawyer review before public launch.
 * GDPR/UK GDPR-aware; DRAFT pending full legal review. privacy@trygoldroad.com is a
 * placeholder (see PR OWNER ACTIONS).
 */
export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy — Goldroad" },
      {
        name: "description",
        content:
          "What Goldroad collects, why, and your rights. We collect almost nothing and never sell your data.",
      },
    ],
  }),
  component: PrivacyPage,
});

const privacy = (
  <ExternalLink
    className="underline underline-offset-2 transition-colors hover:text-ink"
    href="mailto:privacy@trygoldroad.com"
  >
    privacy@trygoldroad.com
  </ExternalLink>
);

function PrivacyPage() {
  return (
    <LegalLayout
      kicker="Goldroad · Privacy"
      title="Privacy policy"
      updated="27 July 2026"
      draft
    >
      <LegalSection heading="The short version">
        <p>
          Goldroad is built so your writing, your subscriber list, and your
          identity live in your own account on the open network — not locked in
          our database. We collect almost nothing, we don't use tracking
          cookies, and we never sell or rent your data. This page spells out the
          detail.
        </p>
      </LegalSection>

      <LegalSection heading="What we collect">
        <LegalList
          items={[
            "Waitlist email — only if you enter it. It's stored in our database to tell you when Goldroad opens, and nowhere else.",
            "Product analytics via PostHog, running cookieless (in-memory): no cookies, no localStorage, no cross-site tracking, and no consent banner needed. Events carry which environment they came from, never your email or personal details.",
            "Sign-in details: when you connect a Bluesky / atproto account, we act on your decentralized identifier (DID). Access tokens stay on our server; we never see or store your password.",
            "Standard server logs (via Cloudflare) — request metadata like IP and user agent, kept briefly for security and debugging.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="What we don't do">
        <p>
          We don't sell, rent, or share your personal data with advertisers or
          data brokers. We don't run ad networks or cross-site trackers. The
          content you publish is public by nature — it lives in your own repo on
          the open network — but your email and account details are not a
          product.
        </p>
      </LegalSection>

      <LegalSection heading="Lawful basis (GDPR / UK GDPR)">
        <LegalList
          items={[
            "Consent — for adding you to the waitlist and later emailing you.",
            "Legitimate interests — for security, abuse prevention, and privacy-respecting analytics that keep the service working.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          If you've connected a Bluesky account, Settings → Your data lets you
          download everything we hold for your account and delete it yourself,
          immediately — no waiting on us. (Deleting your account never touches
          what you've published: those posts live in your own data repo, not
          ours.)
        </p>
        <p className="mt-3">
          If you're only on the waitlist — no account connected — email{" "}
          {privacy} to be removed; we act on it by hand. Wherever you live —
          including under the EU/UK GDPR — you can also ask to access, correct,
          or delete your data, or object to processing, the same way.
        </p>
      </LegalSection>

      <LegalSection heading="Retention">
        <LegalList
          items={[
            "Waitlist email: kept until you ask us to remove it, or until the waitlist is retired.",
            "Analytics: aggregated, not tied to your identity.",
            "Drafts and import history: kept until you delete them (Settings → Your data) or delete your account, which removes both immediately.",
            "Follower counts: while you have an account we record your public Bluesky follower count once a day, so you can see your own growth over time — Bluesky only reports today's number, and the past can't be recovered later. It's in your data export, and deleting your account deletes it.",
            "Sign-in sessions: kept until you sign out, delete your account, or the session expires.",
            "Server logs: short-lived (days), then discarded.",
          ]}
        />
      </LegalSection>

      <LegalSection heading="International transfers & representatives">
        <p>
          Goldroad runs on globally distributed infrastructure, so data may be
          processed outside your country. We rely on appropriate safeguards for
          such transfers. An EU/UK representative will be named here before
          public launch if one is required.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>Privacy questions or data requests: {privacy}.</p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          If we change this policy, we'll update the date above and, for
          material changes, tell people who are on the list.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
