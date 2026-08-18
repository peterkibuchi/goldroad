import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PrivacyPage } from "../routes/privacy";

/**
 * The privacy policy is a promise about code. These tests pin the two halves
 * together at the one place they came apart: /settings' export and deletion
 * reach every row keyed by the writer's DID, and nothing else — but a writer's
 * email can also sit in `waitlist` (they joined the launch list) or `reports`
 * (they filed an abuse report), both keyed by the address with no DID beside
 * it and no way to derive one (~/lib/rights-store spells out why). So the page
 * has to disclose those rows, must not claim the buttons cover them, and has
 * to name the by-hand remedy.
 *
 * If a verified DID↔email link ever exists and the code starts covering those
 * rows, these tests are the ones to rewrite — deliberately.
 */

// Tests live outside `src/routes/` so the file-based router does not pick them
// up as route files.
// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

function textOf(): string {
  return render(<PrivacyPage />).container.textContent ?? "";
}

describe("privacy policy — what we collect", () => {
  it("discloses the report form's email, not just the waitlist's", async () => {
    const text = textOf();
    expect(text).toMatch(/waitlist email/i);
    // The reports table holds url + reason + optional email; an undisclosed
    // collection is the same failure as an unreachable one.
    expect(text).toMatch(/abuse reports?/i);
    expect(text).toMatch(/report form/i);
  });
});

describe("privacy policy — the reader email a publication holds", () => {
  it("discloses the address, which publication, and when", () => {
    // `reader_emails` stores exactly three facts about a reader; an undisclosed
    // collection is the same failure as an unreachable one.
    const text = textOf();
    expect(text).toMatch(/reader email/i);
    expect(text).toMatch(/leave your address with a publication/i);
    expect(text).toMatch(/which publication it was, and when/i);
  });

  it("names all three ways it goes away, and promises no send date", () => {
    const text = textOf();
    // Three, not two: account deletion now sweeps this table, so a policy that
    // still said "until sending opens or you ask" would be describing a
    // retention rule we no longer follow.
    expect(text).toMatch(/until email sending opens/i);
    expect(text).toMatch(/until they delete their Goldroad account/i);
    expect(text).toMatch(/until you ask us to delete it/i);
    expect(text).not.toMatch(/\bsoon\b|\bshortly\b/i);
  });

  it("places it on the writer's side of the self-service line, not the reader's", () => {
    // The row is keyed to the WRITER's DID, never the reader's. That cuts both
    // ways and the page has to say both halves: it travels with the writer's
    // export and deletion, and a READER's own buttons still cannot see it —
    // which is why the by-hand remedy below it has to exist.
    const text = textOf();
    expect(text).toMatch(/left with a publication you were reading/i);
    expect(text).toMatch(/goes out in their export/i);
    expect(text).toMatch(/deleted when they\s+delete their account/i);
    expect(text).toMatch(/your own buttons can't see it/i);
  });
});

/**
 * Announcing is default-ON, and turning a default on means we now write down a
 * preference and a running count of what we did under it. That is a setting
 * plus timestamped publishing-activity metadata about a named person, so it is
 * a collection like any other and gets disclosed like any other — the
 * reader_emails line is the precedent this follows.
 */
describe("privacy policy — the announcing preference we store", () => {
  it("discloses the setting, the counter, and what the counter is for", () => {
    const text = textOf();
    expect(text).toMatch(/announcing preferences/i);
    // Not just "a setting": the hourly counter is the part a reader would not
    // guess, and it is activity metadata, not configuration.
    expect(text).toMatch(/count of the announcements/i);
    expect(text).toMatch(/current hour/i);
    // Why it exists, so the counter reads as a limit on us rather than
    // surveillance of them.
    expect(text).toMatch(/cap/i);
  });

  it("says it is reachable — in the export, and gone on deletion", () => {
    const text = textOf();
    expect(text).toMatch(
      /in your data export, and deleting your account deletes it/i,
    );
  });
});

/**
 * The reader-email line had a true sentence that became incomplete the moment
 * account deletion started sweeping the table: "held until sending opens or you
 * ask" left out the third way an address goes away.
 */
describe("privacy policy — reader email retention after this change", () => {
  it("names account deletion as a way the address goes away", () => {
    expect(textOf()).toMatch(/until they delete their Goldroad account/i);
  });

  it("keeps the reader's own remedy, and says no account is needed to ask", () => {
    const text = textOf();
    expect(text).toMatch(/we'll remove it/i);
    expect(text).toMatch(/don't need an account here to ask/i);
  });
});

describe("privacy policy — your rights", () => {
  it("scopes the self-service claim to the account, and enumerates it", async () => {
    const text = textOf();
    // "everything we hold" full stop was the overclaim: it isn't everything,
    // it's everything under the DID.
    expect(text).toMatch(/everything we hold under that account/i);
    for (const category of [
      /drafts/i,
      /import history/i,
      /follower history/i,
      /announcing preferences/i,
      /reader addresses left with your publication/i,
      /sign-in session/i,
    ]) {
      expect(text).toMatch(category);
    }
  });

  it("says plainly that export and deletion cannot reach a bare email", async () => {
    const text = textOf();
    expect(text).toMatch(/can't reach/i);
    // The reason, not just the fact — DID-keyed accounts, email never received.
    expect(text).toMatch(/identify accounts by\s+DID/i);
    expect(text).toMatch(/never ask for or receive your email/i);
    expect(text).toMatch(/can't include it and account deletion can't remove/i);
  });

  it("names the by-hand remedy, and that it applies to account holders too", async () => {
    const { container } = render(<PrivacyPage />);
    expect(container.textContent).toMatch(/delete it by hand/i);
    expect(container.textContent).toMatch(
      /whether or not you also have an account/i,
    );
    // A remedy needs a reachable address, not just a promise of one.
    const mailto = [...container.querySelectorAll("a")].filter((a) =>
      a.getAttribute("href")?.startsWith("mailto:privacy@"),
    );
    expect(mailto.length).toBeGreaterThan(0);
  });
});

describe("privacy policy — retention", () => {
  it("keeps the waitlist line honest about account deletion", async () => {
    expect(textOf()).toMatch(/deleting a goldroad account does not remove it/i);
  });

  it("states a retention position for abuse reports", async () => {
    expect(textOf()).toMatch(/moderation and appeals/i);
  });
});
