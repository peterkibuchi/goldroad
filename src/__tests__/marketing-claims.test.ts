import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Landing } from "#/routes/index";
import { LeavingSubstack } from "#/routes/leaving-substack";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

/**
 * A guard against the failure class that has now bitten this project three
 * times: MARKETING COPY CLAIMING A CAPABILITY THAT DOES NOT EXIST.
 *
 * The history, because it explains the shape of this file:
 *   1. `/leaving-substack` said the subscriber list was "yours; export any day".
 *   2. The homepage said "Subscriber emails export any day" — the same claim,
 *      missed because the fix went to one page and the claim lived on two.
 *   3. The homepage said import had not landed while `/leaving-substack` said it
 *      had, so the two pages contradicted each other to the same reader.
 *
 * Every one of them passed review, a green gate and a deploy, because nothing
 * mechanical was watching. Copy is not covered by types, and a claim is a
 * behaviour: "we do X" is as testable as X itself, and wrong in the same way.
 *
 * WHAT THIS CAN AND CANNOT DO. It cannot judge prose. What it can do is refuse
 * the exact phrasings that shipped falsely, and pin the roadmap flags on the
 * comparison table so an unshipped row cannot quietly lose its tag. When a
 * feature genuinely ships, the fix is to DELETE its entry here in the same
 * commit that changes the copy — which is the point: the deletion is the moment
 * someone consciously decides the claim is now true.
 */

const SRC = join(import.meta.dirname, "..");
const ROUTES = join(SRC, "routes");
const read = (file: string) => readFileSync(join(ROUTES, file), "utf8");

/**
 * The same source with every whitespace run collapsed to one space. JSX text is
 * re-wrapped by the formatter, so a banned phrase can hide across a line break
 * and a required phrase can appear to be missing for the same reason. Matching
 * on the flattened source removes the formatter from the equation.
 */
const readFlat = (file: string) => read(file).replace(/\s+/g, " ");

const MARKETING_PAGES = [
  "index.tsx",
  "leaving-substack.tsx",
  "open.tsx",
] as const;

/**
 * Phrasings that were live and false. Each entry names the capability and the
 * date it was corrected, so a future reader can tell a stale guard from a live
 * one — and so removing an entry requires saying why.
 */
const FALSE_CLAIMS: ReadonlyArray<{ phrase: string; why: string }> = [
  {
    phrase: "emails export any day",
    why: "no subscriber list exists to export (corrected 2026-07-31)",
  },
  {
    phrase: "Your domain.",
    why: "custom domains are not built; the phrase sat in an unrendered A/B variant, which is exactly where a false claim waits until someone ships it (corrected 2026-08-07)",
  },
  {
    phrase: "is either your invite",
    why: "there is no invite gate — the header's sign-in link opens the product to anyone with a Bluesky account, so this told writers to wait for a door that was already open (corrected 2026-08-01)",
  },
  {
    // Second occurrence of the same class: the 2026-08-01 correction landed on
    // one string, and the waitlist helper kept promising "one email when your
    // invite is ready" for a fortnight afterwards. Banning the possessive
    // outright is what stops a third. It matches comments as well as copy,
    // deliberately: a comment quoting the dead phrasing is how it comes back.
    phrase: "your invite",
    why: "there is no invite to wait for, in any phrasing — the product opens to anyone with a Bluesky account, and a list that gates nothing must not imply it does (corrected 2026-08-16)",
  },
  {
    phrase: "Full-text RSS",
    why: "the feed renders markdown at request time, and a 10 ms CPU budget only covers short posts — full text needs HTML rendered once at publish, not per request (corrected 2026-08-01)",
  },
  {
    phrase: "carrying the whole post, not an excerpt",
    why: "same claim, and it explicitly contrasted with Substack on the one axis we could not hold (corrected 2026-08-01)",
  },
  {
    phrase: "Subscriber emails export",
    why: "same claim, different phrasing (corrected 2026-07-31)",
  },
  {
    phrase: "and Substack import land",
    why: "import IS live; this said it wasn't, contradicting /leaving-substack (corrected 2026-07-31)",
  },
  {
    phrase: "your list, your name",
    why: "'your list' implies a subscriber list we do not have (corrected 2026-07-31)",
  },
];

describe("marketing copy makes no claim we cannot keep", () => {
  for (const page of MARKETING_PAGES) {
    it(`${page} carries none of the phrasings that shipped falsely`, () => {
      const source = readFlat(page);
      for (const { phrase, why } of FALSE_CLAIMS) {
        expect(
          source.includes(phrase),
          `${page} contains "${phrase}" — ${why}`,
        ).toBe(false);
      }
    });
  }

  it("qualifies every 0% claim with the fact that payments have not shipped", () => {
    // 0% is a permanent POLICY and may be stated as such. What must not appear
    // is language implying money changes hands today. A naive substring ban
    // fails here — the first version of this test flagged copy that was already
    // correct, because it matched the trailing clause of a properly qualified
    // sentence. So the rule is checked as it is actually written: every mention
    // of taking 0% must sit near a marker that payments are still ahead.
    for (const page of MARKETING_PAGES) {
      const source = read(page);
      const claim = /take (?:zero|0%)/g;
      for (const match of source.matchAll(claim)) {
        const window = source.slice(
          Math.max(0, match.index - 160),
          match.index + 80,
        );
        expect(
          /\bship(?:s|ped|ping)?\b|\bwill\b|roadmap/i.test(window),
          `${page}: "${match[0]}" is not qualified as future — payments have not shipped`,
        ).toBe(true);
      }
    }
  });

  /**
   * The inverse of a banned phrase: a sentence that MUST be present. "0%" is
   * true and architectural, but a writer can read it next to "Substack takes
   * 10%" as "so I keep 100% of gross" and then meet their processor's fee on
   * the first payout — the one claim the whole position rests on, caught being
   * shaded. So the two surfaces that pitch 0% must also name the fee.
   *
   * `/open` is deliberately absent: its "We take 0% of what readers pay
   * writers, permanently" is a policy statement to people reading about the
   * licence, and the qualifier there is noise. That omission is a decision.
   *
   * REQUIRED phrases are matched against the RENDERED page, where the banned
   * ones above are matched against raw source. The asymmetry is deliberate and
   * it is the point of the split: a ban must bite wherever the phrasing appears,
   * including in a comment, because a comment quoting a dead phrase is how it
   * comes back. A requirement is the opposite — source-matching passes so long
   * as the words exist *somewhere* in the file, so a disclosure that survives
   * only in a comment, or in a constant the page never renders, reads as present
   * while the reader is told nothing. This project has already shipped a false
   * claim out of an unrendered A/B variant (see "Your domain." above); this is
   * that same hole pointed the other way, and rendering is what closes it.
   */
  const PROCESSOR_FEE: ReadonlyArray<{
    surface: string;
    ui: () => ReactElement;
    phrase: string;
    why: string;
  }> = [
    {
      surface: "the landing page",
      ui: () => createElement(Landing),
      phrase: "Your payment processor still charges its own fee",
      why: "generic, because bring-your-own-processor means whichever one serves the writer's country",
    },
    {
      surface: "/leaving-substack",
      ui: () => createElement(LeavingSubstack),
      phrase: "Stripe's processing fee",
      why: "named, because a Substack refugee already holds a Stripe account — and this is the only page carrying arithmetic",
    },
  ];

  for (const { surface, ui, phrase, why } of PROCESSOR_FEE) {
    it(`${surface} shows the reader our 0% take is not the processor's fee`, () => {
      const { container } = render(ui());
      // Flattened for the same reason the source reader is: JSX text arrives
      // in the DOM re-wrapped by the formatter's line breaks.
      const shown = (container.textContent ?? "").replace(/\s+/g, " ");
      expect(
        shown.includes(phrase),
        `${surface} no longer SHOWS "${phrase}" — ${why}. Without it on the page, 0% reads as "payments are free".`,
      ).toBe(true);
    });
  }

  /**
   * The no-ads promise. It lives in exactly two places — the comparison row and
   * the prose beside it — and a cadence pass rewrote both wordings in one commit,
   * which is exactly when a promise can evaporate without anyone deciding to
   * drop it.
   *
   * Deliberately matched as a CONCEPT, not a sentence. The promise has to keep
   * its scope ("and not later either"), because an unscoped "we don't sell ads"
   * reads as "not yet" beside a competitor who just started. Pinning one exact
   * phrasing would make the next honest rewrite fail this test, and a test that
   * punishes rewording is a test someone eventually deletes — so any phrasing
   * that carries the scope passes, and losing the scope altogether is the only
   * failure.
   */
  it("/leaving-substack still refuses ads at any size, not merely for now", () => {
    const { container } = render(createElement(LeavingSubstack));
    const shown = (container.textContent ?? "").replace(/\s+/g, " ");
    // Substack's June 2026 sponsorship launch is the fact this contrasts with;
    // our own refusal has to survive next to it.
    expect(shown).toMatch(/sponsorships/i);
    expect(
      /however big this gets|at any size|no matter how big|not ever|not later/i.test(
        shown,
      ),
      'the no-ads promise lost its scope: beside Substack\'s sponsorship launch, an unqualified "no ads" reads as "not yet"',
    ).toBe(true);
  });
});

/**
 * THE SAME RULE, ON THE SURFACES THAT ASK A READER FOR SOMETHING.
 *
 * The pages above are where we talk about ourselves. The email capture is where
 * we ask a stranger for their address on a writer's page, which is the harder
 * place to be honest: sending is not built, so every fluent version of that ask
 * ("your first issue", "you're on the list", "we'll be in touch shortly") is a
 * promise about a date nobody has. And an invite is the specific temptation —
 * scarcity reads well and there is no gate here at all, which is the phrasing
 * FALSE_CLAIMS already carries for the homepage.
 *
 * Copy in a component isn't reachable by the page-based scan above, so these
 * surfaces are listed by path from `src/`. A future capture surface belongs here
 * on the day it is written.
 */
const CAPTURE_SURFACES = [
  "components/reader-email-capture.tsx",
  "routes/subscribed.tsx",
] as const;

/** Phrasings the capture must not use, with what each one would be claiming. */
const UNKEEPABLE: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\binvit(e|es|ed|ation)\b/i,
    why: "there is no invite gate behind this field — the same phrasing the homepage had to drop",
  },
  {
    pattern: /\b(soon|shortly|any day now)\b/i,
    why: "email sending has no date, and 'soon' is a date",
  },
  {
    pattern: /\bcoming (soon|shortly|in)\b/i,
    why: "same claim, different phrasing",
  },
  {
    pattern: /\bfirst (issue|newsletter|email) (is|will|lands)/i,
    why: "nothing sends yet, so nothing is queued to arrive",
  },
  {
    pattern: /\bwe'll be in touch\b/i,
    why: "we won't — the writer might, once sending exists",
  },
  {
    pattern: /\bunsubscribe (any ?time|link|with one click)\b/i,
    why: "there is no unsubscribe mechanism to offer while there is no sending; /privacy names the by-hand remedy",
  },
];

/** The visible strings in a surface: comments explain why a claim is NOT made,
 * and must not read as the claim. Same treatment page-accent-budget.test.tsx
 * gives its class scan, and for the same reason. */
function copy(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(?<!:)\/\/[^\n]*/g, "");
}

describe("the email capture claims nothing about a date, and offers no invite", () => {
  for (const file of CAPTURE_SURFACES) {
    it(`${file} keeps the ask honest`, () => {
      const source = copy(file);
      for (const { pattern, why } of UNKEEPABLE) {
        expect(
          pattern.test(source),
          `${file} matches ${pattern} — ${why}`,
        ).toBe(false);
      }
    });

    it(`${file} says out loud that sending isn't switched on`, () => {
      // The inverse guard: silence about the state of sending is its own
      // dishonesty, because a reader assumes an email field sends email.
      expect(copy(file)).toMatch(/isn't switched on/i);
    });
  }
});

/**
 * The comparison table's own honesty flags. `roadmap: true` is what renders the
 * "On the roadmap" tag, so a row losing that flag silently promotes an unbuilt
 * feature to a shipped one — the #90 failure with a different mechanism.
 */
describe("the comparison table tags every unshipped row", () => {
  const source = read("leaving-substack.tsx");

  /** Rows that MUST still carry the flag, with why they are not shipped. */
  const MUST_BE_TAGGED: ReadonlyArray<[string, string]> = [
    ["Your subscriber list", "no list exists yet"],
    ["Newsletters", "email delivery is not built"],
    ["Reader payments", "no payment processing is wired"],
  ];

  for (const [label, why] of MUST_BE_TAGGED) {
    it(`"${label}" is still marked on the roadmap — ${why}`, () => {
      const start = source.indexOf(`label: "${label}"`);
      expect(start, `row "${label}" not found`).toBeGreaterThan(-1);
      // The row object ends at the next `},` at row indentation.
      const row = source.slice(start, source.indexOf("\n  },", start));
      expect(row.includes("roadmap: true"), `"${label}" lost its tag`).toBe(
        true,
      );
    });
  }

  it("only tags rows that are genuinely unshipped", () => {
    // The inverse guard: over-tagging is its own dishonesty, because it hides
    // work we actually did. These shipped today and must NOT carry the tag.
    for (const label of [
      "Import your archive",
      "Feeds",
      "The look of your page",
      "Your archive when you leave",
    ]) {
      const start = source.indexOf(`label: "${label}"`);
      expect(start, `row "${label}" not found`).toBeGreaterThan(-1);
      const row = source.slice(start, source.indexOf("\n  },", start));
      expect(
        row.includes("roadmap: true"),
        `"${label}" is tagged but ships`,
      ).toBe(false);
    }
  });
});
