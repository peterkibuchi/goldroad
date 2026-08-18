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

  it("says how long it is held, and does not promise a send date", () => {
    const text = textOf();
    expect(text).toMatch(/until email sending opens or you ask us to delete/i);
    expect(text).not.toMatch(/\bsoon\b|\bshortly\b/i);
  });

  it("counts it among the things the account buttons can't reach", () => {
    // The row is keyed to the WRITER's DID, never the reader's — so a reader's
    // own export and deletion cannot see it, exactly like the waitlist row.
    expect(textOf()).toMatch(/left with a publication you\s+read/i);
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

  /**
   * The gap this closes: `reader_emails` had no Retention line at all, and the
   * suite above greened over the omission because it only ever asserted the
   * lines that DID exist. Retention is the section a reader goes to for "what
   * happens when the writer leaves", and the answer — the addresses go — was
   * true of the policy's intent and false of the code, in both directions at
   * once: deletion did not reach the table, and the export claimed to hold
   * nothing else keyed to the DID.
   */
  it("says what account deletion does to the reader addresses a writer holds", async () => {
    const text = textOf();
    expect(text).toMatch(/reader emails? left with a publication/i);
    expect(text).toMatch(
      /deleted immediately, in full, if that writer deletes their Goldroad account/i,
    );
  });

  it("says the addresses are never in the writer's export, and why", async () => {
    const text = textOf();
    expect(text).toMatch(/never included in a writer's data export/i);
    // The reason, not just the fact: they are the readers' addresses.
    expect(text).toMatch(/belong to the readers who left them/i);
    expect(text).toMatch(/only how many there are/i);
  });
});
