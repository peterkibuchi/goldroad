import { createFileRoute } from "@tanstack/react-router";

import { ExternalLink } from "~/components/external-link";
import { LegalLayout, LegalList, LegalSection } from "~/components/legal-page";

/**
 * Privacy policy. GDPR/UK GDPR-aware, but DRAFT pending final legal review.
 * privacy@trygoldroad.com is a placeholder until the mailbox is wired.
 */
export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy — Goldroad" },
      {
        name: "description",
        content:
          "What Goldroad collects, why, and your rights — including exporting or deleting everything we hold, any day you like.",
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

/** Exported for tests (account-rights-copy.test.tsx), which pin this page's
 * promises against what the export and deletion paths actually reach — not a
 * route. */
export function PrivacyPage() {
  return (
    <LegalLayout
      kicker="Goldroad · Privacy"
      title="Privacy policy"
      updated="30 July 2026"
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
            "Reader email — if you leave your address with a publication you're reading, we store the address, which publication it was, and when. It's held for that writer until email sending opens, until they delete their Goldroad account, or until you ask us to delete it.",
            "Abuse reports — if you use the report form we store the URL you reported and the note you wrote, plus your email if you chose to leave one, so a human can triage it and follow up with you. So that reports don't sit unread, the URL and the note are also sent to the private channel we use for operational alerts; your email is never included in that.",
            "Product analytics via PostHog, running cookieless (in-memory): no cookies, no localStorage, no cross-site tracking, and no consent banner needed. Events carry which environment they came from, never your email or personal details.",
            "Sign-in details: when you connect a Bluesky / atproto account, we act on your decentralized identifier (DID). Access tokens stay on our server; we never see or store your password.",
            "Announcing preferences — whether you want Goldroad to post a new article to Bluesky for you. We store that setting against your DID, plus a count of the announcements the automatic path has posted for you in the current hour and when that hour started, which is how the cap on it is enforced. It's a setting and a timestamp of your own publishing activity, it's in your data export, and deleting your account deletes it.",
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
          download everything we hold under that account — your drafts, import
          history, follower history, announcing preferences, any reader
          addresses left with your publication, and your sign-in session — and
          delete all of it yourself, immediately, no waiting on us. (Deleting
          your account never touches what you've published: those posts live in
          your own data repo, not ours.)
        </p>
        <p className="mt-3">
          What those buttons can't reach is an email address of <em>yours</em>{" "}
          that isn't attached to an account: one you typed into the waitlist
          form, or left on an abuse report. Those are stored by the address
          alone. We identify accounts by DID and never ask for or receive your
          email address, so there is genuinely nothing in our database that
          could tell us a given account and a given email are the same person —
          which also means an export can't include it and account deletion can't
          remove it. Email {privacy} from or naming that address and we'll
          delete it by hand, whether or not you also have an account here.
        </p>
        <p className="mt-3">
          An address you left with a publication you were reading is the one
          case that sits on the other side of that line. It's held for that
          writer, so it goes out in their export and it's deleted when they
          delete their account — but it isn't keyed to any account of yours, so
          your own buttons can't see it. Email {privacy} naming the address and
          we'll remove it; you don't need an account here to ask.
        </p>
        <p className="mt-3">
          Wherever you live — including under the EU/UK GDPR — you can ask to
          access, correct, or delete your data, or object to processing, the
          same way.
        </p>
      </LegalSection>

      <LegalSection heading="Retention">
        <LegalList
          items={[
            "Waitlist email: kept until you ask us to remove it, or until the waitlist is retired. Deleting a Goldroad account does not remove it — see Your rights above.",
            "Abuse reports: the report, and any email left with it, kept while we may still need it for moderation and appeals, then discarded — or sooner if you ask. The alert copy described above lives in that channel's own history, so removing a report here doesn't reach back into it.",
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
