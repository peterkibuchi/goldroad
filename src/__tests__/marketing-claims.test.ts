// @vitest-environment node

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const ROUTES = join(import.meta.dirname, "..", "routes");
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
   */
  const PROCESSOR_FEE: ReadonlyArray<{
    page: string;
    phrase: string;
    why: string;
  }> = [
    {
      page: "index.tsx",
      phrase: "Your payment processor still charges its own fee",
      why: "generic, because bring-your-own-processor means whichever one serves the writer's country",
    },
    {
      page: "leaving-substack.tsx",
      phrase: "Stripe's processing fee",
      why: "named, because a Substack refugee already holds a Stripe account — and this is the only page carrying arithmetic",
    },
  ];

  for (const { page, phrase, why } of PROCESSOR_FEE) {
    it(`${page} distinguishes our 0% take from the processor's fee`, () => {
      expect(
        readFlat(page).includes(phrase),
        `${page} lost "${phrase}" — ${why}. Without it, 0% reads as "payments are free".`,
      ).toBe(true);
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
