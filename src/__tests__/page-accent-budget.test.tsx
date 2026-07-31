/**
 * The accent budget, ON THE PAGES.
 *
 * docs/DESIGN.md: spot colour is scarce — one accent moment per view — and on
 * the signed-in writer surfaces that moment is spent by the command rail's
 * "New post". The consequence is paid on the pages: a page-level primary on
 * those surfaces takes the ink vocabulary (`bg-ink … hover:bg-spot`) instead.
 *
 * site-chrome.test.tsx already guards the chrome's half of that budget, but it
 * counts spot elements inside AppShell's own markup only. Nothing counted the
 * page rendered INSIDE the shell, so /write, /settings and /import kept their
 * spot primaries for as long as they liked with the suite green — /settings
 * showed four accents at once. Hence this file.
 *
 * It works two ways, because neither alone is enough:
 *
 *   1. RENDERED — mount each page body that mounts without route plumbing and
 *      count the resting spot elements in it. Real DOM, real classes.
 *   2. INVENTORY — read the surface files and tally every resting spot class in
 *      them against a named allowlist. This is the part that can't be dodged by
 *      forgetting to mount something: it covers the page bodies that need a
 *      loader or a BlockNote mock to render (write.tsx's Publish, settings.tsx's
 *      publication form, import.tsx's pick list), and any file added to a
 *      surface later.
 *
 * "Resting" is the operative word throughout. `hover:bg-spot` spends nothing
 * until a pointer is on it, and a focus ring is required to be spot by the
 * accessibility baseline — only what the writer sees with their hands still
 * counts against the budget.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeEditor } from "../components/theme-editor";
import { PostsManager } from "../routes/dashboard";
import { Overview } from "../routes/home";
import { SourcePicker } from "../routes/import";
import { DeleteAccountForm } from "../routes/settings";
import { VIEWS_OFF } from "./support/views-envelope";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Both page bodies read /api/stats on mount; neither test is about views. */
function stubStats() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(VIEWS_OFF))),
  );
}

/** A single class token that paints the accent at rest. Variants
 * (`hover:`, `focus-visible:`, `peer-focus-visible:`, `disabled:`) are excluded
 * by construction: the prefix is part of the token, so it can't match. */
const RESTING_SPOT =
  /^(?:bg-spot|text-spot|border-spot|outline-spot|spot-highlight)(?:\/\d+)?$/;

/**
 * Every element painting our accent on the page as the writer finds it. Two
 * subtrees are excluded, and both exclusions are the design rule rather than
 * convenience:
 *
 *   - `[data-writer-theme]` — the theme preview overrides --color-spot to the
 *     writer's own accent inside its own subtree. Those pixels are never our
 *     vermillion, so they cost the page nothing.
 *   - a closed `<dialog>` — a confirmation that hasn't been summoned isn't on
 *     screen, and when it is, it owns the whole view and dims everything
 *     behind it. Destructive confirmations are allowed the accent there.
 */
function restingSpotElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[class]")].filter(
    (el) =>
      !el.closest("[data-writer-theme]") &&
      !el.closest("dialog:not([open])") &&
      [...el.classList].some((token) => RESTING_SPOT.test(token)),
  );
}

/** A resting `bg-spot` in a class string, whatever its position — the variant
 * forms (`hover:bg-spot`) are excluded by the lookbehind. */
const RESTING_FILL = /(?<![\w:/-])bg-spot(?![\w-])/;

/** The demoted vocabulary, asserted as a pair: ink at rest is only half of it —
 * a primary that never reaches for the accent on hover reads as disabled. */
function expectInkVocabulary(classes: string, label: string): void {
  expect(classes, `${label}: rests on ink`).toContain("bg-ink");
  expect(classes, `${label}: hovers to spot`).toContain("hover:bg-spot");
  expect(classes, `${label}: no resting accent`).not.toMatch(RESTING_FILL);
}

describe("rendered: a signed-in page spends no accent of its own", () => {
  it("/home — the next action is ink", () => {
    stubStats();
    render(
      <Overview
        drafts={[]}
        engagement={null}
        iconPath={null}
        ident="writer.example"
        publicationName="Field Notes"
        published={{ count: 0, countComplete: true, latest: null }}
      />,
    );
    expect(restingSpotElements(document.body)).toEqual([]);
    const start = screen.getByRole("link", { name: /start writing/i });
    expectInkVocabulary(start.className, "Start writing");
  });

  it("/dashboard — the manager carries no primary at all", () => {
    stubStats();
    render(
      <PostsManager
        drafts={[]}
        engagement={new Map()}
        ident="writer.example"
        nextCursor={null}
        onTabChange={() => {}}
        rows={[]}
        scheduled={[]}
        tab="published"
      />,
    );
    expect(restingSpotElements(document.body)).toEqual([]);
  });

  it("/import — 'Find my posts' is ink", () => {
    render(
      <SourcePicker
        busy={null}
        error={null}
        onFeed={() => {}}
        onFile={() => {}}
      />,
    );
    expect(restingSpotElements(document.body)).toEqual([]);
    const find = screen.getByRole("button", { name: /find my posts/i });
    expectInkVocabulary(find.className, "Find my posts");
  });

  it("/settings — 'Save colours' is ink, and the writer's own accent doesn't count", () => {
    render(<ThemeEditor publicationName="Field Notes" theme={null} />);
    expect(restingSpotElements(document.body)).toEqual([]);
    const save = screen.getByRole("button", { name: /save colours/i });
    expectInkVocabulary(save.className, "Save colours");
    // The preview really does paint spot — it just isn't ours.
    const preview = document.querySelector("[data-writer-theme]");
    expect(preview?.querySelector(".bg-spot")).not.toBeNull();
  });

  /**
   * The one exception, and the reason the save buttons above had to go first.
   * DESIGN.md's interaction vocabulary gives destructive actions the accent
   * ("destructive actions hover to spot and confirm before acting"), and
   * deleting an account is the one thing on /settings that should stop a writer
   * mid-scroll. That allowance is affordable only because nothing else on the
   * page takes spot — which is what this file now enforces.
   */
  it("/settings — 'Delete account' keeps the accent, and is the only page element that does", () => {
    render(<DeleteAccountForm ident="writer.example" />);
    const spot = restingSpotElements(document.body);
    expect(spot).toHaveLength(1);
    expect(spot[0].textContent).toBe("Delete account");
    // Outline, not fill: a warning, not the page's primary action.
    expect(spot[0].className).toContain("border-spot");
    expect(spot[0].className).toContain("text-spot");
    expect(spot[0].className).not.toMatch(RESTING_FILL);
    // Its confirmation is a filled accent, and stays uncounted only because it
    // lives in a modal that has to be summoned.
    // `hidden: true` because that is exactly the point: a closed dialog is out
    // of the accessibility tree, so nobody is looking at its accent yet.
    const confirm = screen.getByRole("button", {
      hidden: true,
      name: /delete my account/i,
    });
    expect(confirm.closest("dialog")?.hasAttribute("open")).toBe(false);
    expect(confirm.className).toMatch(RESTING_FILL);
  });
});

/**
 * Every file that renders inside the signed-in AppShell. The chrome itself
 * (site-chrome.tsx) is deliberately absent: its accent is the budget, and
 * site-chrome.test.tsx counts it.
 */
const SURFACES = [
  "routes/home.tsx",
  "routes/dashboard.tsx",
  "routes/settings.tsx",
  "routes/stats.tsx",
  "routes/import.tsx",
  "routes/write.tsx",
  "components/theme-editor.tsx",
];

/**
 * Named exceptions: every resting accent allowed on a signed-in surface, with
 * the reason it earns one. A page-level primary action is NOT on this list and
 * must never be added to it — that is the rule the file exists to hold.
 *
 * A `count` that no longer matches fails in both directions on purpose: a new
 * accent is drift, and a stale entry is a comment that has stopped being true.
 *
 * `why` is documentation rather than an assertion, and that is the point of
 * keeping the list here: adding an accent means writing the sentence that
 * justifies it, in the same commit, where a reviewer will read it.
 */
const ALLOWED: Array<{
  file: string;
  token: string;
  count: number;
  why: string;
}> = [
  {
    file: "routes/dashboard.tsx",
    token: "bg-spot",
    count: 1,
    why: "Confirming a post deletion, inside a modal that is only in the DOM when a post was announced. Destructive, and it owns the whole view while it is open.",
  },
  {
    file: "routes/settings.tsx",
    token: "bg-spot",
    count: 1,
    why: "Confirming account deletion, in the same kind of modal.",
  },
  {
    file: "routes/settings.tsx",
    token: "border-spot",
    count: 1,
    why: "'Delete account' — destructive actions earn the accent (DESIGN.md's interaction vocabulary). The band's outline half.",
  },
  {
    file: "routes/settings.tsx",
    token: "text-spot",
    count: 2,
    why: "'Delete account' (the same button's label) and the icon field's error line — spot's second meaning in this app is an error, and neither is on screen at rest.",
  },
  {
    file: "routes/import.tsx",
    token: "border-spot",
    count: 1,
    why: "The drop zone while a file is dragged over it: transient feedback, gone the moment the pointer leaves.",
  },
  {
    file: "routes/import.tsx",
    token: "bg-spot/5",
    count: 1,
    why: "The same drag state's 5%-opacity wash.",
  },
  {
    file: "routes/write.tsx",
    token: "bg-spot",
    count: 1,
    why: "'Continue' on the signed-out sign-in panel. No rail there, so the page keeps its own accent moment.",
  },
  {
    file: "routes/write.tsx",
    token: "border-spot",
    count: 1,
    why: "The sign-in panel's error notice, on the same signed-out surface.",
  },
  {
    file: "routes/write.tsx",
    token: "text-spot",
    count: 3,
    why: "That error notice plus the cover and schedule error lines — errors, not primaries, and absent at rest.",
  },
  {
    file: "components/theme-editor.tsx",
    token: "bg-spot",
    count: 1,
    why: "Inside the theme preview, which overrides --color-spot to the writer's own accent. Never our vermillion.",
  },
];

const SRC = join(import.meta.dirname, "..");

/** Comments are stripped before scanning: this rule is about what ships to a
 * browser, and a comment explaining why something is NOT spot shouldn't read as
 * an accent. The `\/\/` case guards against eating `https://…` inside a string. */
function code(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(?<!:)\/\/[^\n]*/g, "");
}

/** Every resting accent token in a file, tallied. The lookbehind drops variant
 * prefixes (`hover:bg-spot`) and the lookahead drops longer names that merely
 * start the same way (`text-spot-foreground`, the writer-accent pairing). */
function tally(file: string): Map<string, number> {
  const pattern =
    /(?<![\w:/-])(?:bg-spot|text-spot|border-spot|outline-spot|spot-highlight)(?:\/\d+)?(?![\w-])/g;
  const counts = new Map<string, number>();
  for (const [token] of code(file).matchAll(pattern)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** file → token → count, as a flat sorted list so a mismatch prints readably. */
function inventory(counts: Iterable<[string, Map<string, number>]>): string[] {
  const lines: string[] = [];
  for (const [file, tokens] of counts) {
    for (const [token, count] of tokens)
      lines.push(`${file} ${token} ×${count}`);
  }
  return lines.sort();
}

describe("inventory: every resting accent on a signed-in surface is a named exception", () => {
  it("matches the allowlist exactly, file by file", () => {
    const actual = inventory(SURFACES.map((file) => [file, tally(file)]));
    const expected = inventory(
      SURFACES.map((file) => [
        file,
        new Map(
          ALLOWED.filter((entry) => entry.file === file).map((entry) => [
            entry.token,
            entry.count,
          ]),
        ),
      ]),
    );
    // A failure here is one of two things: a page took the accent back (demote
    // it to `bg-ink … hover:bg-spot`), or a genuinely new exception needs a
    // line in ALLOWED saying why it earns one.
    expect(actual).toEqual(expected);
  });

  it("no signed-in surface fills a page primary with the accent", () => {
    // The specific failure that shipped three times: a `bg-spot` submit button
    // on a page whose rail already spends the accent. The allowlist's only
    // `bg-spot` fills are destructive confirmations in modals, a signed-out
    // panel, and the writer's own theme preview — never a page primary.
    for (const file of SURFACES) {
      const fills = tally(file).get("bg-spot") ?? 0;
      const allowed = ALLOWED.filter(
        (entry) => entry.file === file && entry.token === "bg-spot",
      ).reduce((sum, entry) => sum + entry.count, 0);
      expect({ file, fills }).toEqual({ file, fills: allowed });
    }
  });

  /**
   * Every page primary on a signed-in surface, found by the JSX that renders
   * its label and checked against the class string above it. The three no
   * rendered test can reach are the whole reason this reads source: Publish
   * needs a BlockNote mock, and the publication form and the import pick list
   * live inside route components that aren't exported.
   */
  const PRIMARIES: Array<[string, string]> = [
    ["routes/write.tsx", '{editing ? "Save changes" : "Publish"}'],
    // Anchored on the ternary's tail rather than the whole expression: the
    // CONDITION on that label is free to change (it already has, to cover a
    // publication we couldn't read), and what this test cares about is the
    // button, not the branch that picks its word.
    ["routes/settings.tsx", ': "Create publication"}'],
    ["components/theme-editor.tsx", "Save colours"],
    ["routes/import.tsx", "Find my posts"],
    ["routes/import.tsx", "Import {count} to drafts"],
    ["routes/home.tsx", "Start writing"],
  ];

  it.each(PRIMARIES)("%s: the primary labelled %s wears ink", (file, label) => {
    const source = code(file);
    // One occurrence, so "the class string above it" is unambiguous.
    expect(source.indexOf(label), `"${label}" is missing`).toBeGreaterThan(-1);
    expect(source.indexOf(label), `"${label}" appears twice`).toBe(
      source.lastIndexOf(label),
    );
    const before = source.slice(0, source.indexOf(label));
    const classes = [...before.matchAll(/className="([^"]*)"/g)].at(-1)?.[1];
    expectInkVocabulary(classes ?? "", `${file} → ${label}`);
  });
});
