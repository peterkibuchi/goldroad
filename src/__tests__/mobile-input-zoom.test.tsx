/**
 * The 16px floor on form controls.
 *
 * iOS Safari zooms the whole page in when a focused input, select or textarea
 * computes under 16px — and it does not zoom back out. The writer is left on a
 * zoomed, horizontally-panning page after tapping a search field. Five controls
 * shipped under the floor: the stats sort select (12px), the posts manager's
 * search and sort (14px), the schedule field on /write (14px), and the public
 * archive's search (14px), which is often a phone visitor's first interaction
 * with a publication.
 *
 * The fix is per-control rather than a `@media (pointer: coarse)` block in
 * styles.css: 16px at base, the denser size back from `sm:` up. The alternative
 * — `maximum-scale=1` on the viewport — would stop the zoom by taking pinch-zoom
 * away from everyone, which is an accessibility failure, not a fix.
 *
 * Two halves, for the same reason page-accent-budget.test.tsx has two:
 *
 *   1. RENDERED — mount the surfaces that mount without route plumbing and read
 *      the classes off the real controls.
 *   2. INVENTORY — scan every source file for a form control carrying an
 *      unprefixed `text-xs`/`text-sm`, which is the exact shape of this bug and
 *      covers the controls that need a loader or a session to render.
 *
 * These are class-string assertions, deliberately: jsdom computes no styles, so
 * there is no font-size to measure. What they can hold is the token that decides
 * it, and the inventory half is the one that cannot be dodged by forgetting to
 * mount something.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostTable } from "#/components/stats/post-table";
import type { DashboardRow } from "#/lib/dashboard";
import type { PostMetrics } from "#/lib/stats-posts";
import { PostsManager } from "../routes/dashboard";
import { VIEWS_OFF } from "./support/views-envelope";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** An unprefixed size under 16px. Variants can't match: the prefix is part of
 * the token, so `sm:text-sm` — the whole point of the fix — is not this. */
const UNDER_FLOOR = /^text-(?:xs|sm)$/;

/** 16px or larger, stated on the control itself. Required rather than merely
 * allowed: a bare control inherits, and two of these five sat inside a
 * `text-sm` label, which is how the dashboard's sort select got to 14px with no
 * size class of its own. */
const AT_OR_ABOVE_FLOOR = /^text-(?:base|lg|xl|\d+xl)$/;

/** Input types that never focus a text caret, so iOS has nothing to zoom for. */
const NO_CARET = new Set([
  "hidden",
  "checkbox",
  "radio",
  "color",
  "file",
  "submit",
  "button",
  "reset",
  "image",
  "range",
]);

function typedControls(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("input, select, textarea"),
  ].filter((el) => !NO_CARET.has(el.getAttribute("type") ?? ""));
}

function expectClearsFloor(el: HTMLElement, label: string): void {
  const tokens = el.className.split(/\s+/).filter(Boolean);
  expect(
    tokens.filter((token) => UNDER_FLOOR.test(token)),
    `${label}: carries a base size under 16px`,
  ).toEqual([]);
  expect(
    tokens.some((token) => AT_OR_ABOVE_FLOOR.test(token)),
    `${label}: states its own size at 16px or above`,
  ).toBe(true);
}

const POST: PostMetrics = {
  rkey: "3aaa2aaa2aaa2",
  title: "Anchor essay",
  date: "1 January 2026",
  publishedAt: "2026-01-01T00:00:00.000Z",
  readingMinutes: 4,
  editable: true,
  announced: null,
  views: null,
  likes: null,
  reposts: null,
  replies: null,
  gone: false,
};

/** The manager hides its search and sort on a genuinely empty account, so the
 * controls under test need a post to exist. */
const PUBLISHED: DashboardRow[] = [
  {
    rkey: POST.rkey,
    title: POST.title,
    description: null,
    publishedAt: POST.publishedAt,
    updatedAt: null,
    coverPath: null,
    readingMinutes: 4,
    editable: true,
    announced: null,
  },
];

describe("rendered: every control a writer taps clears the 16px floor", () => {
  it("/stats — the phone-only sort select", () => {
    const { container } = render(
      <PostTable
        direction="desc"
        ident="writer.example"
        loading={false}
        metricsUnavailable={false}
        onSortChange={() => {}}
        rows={[POST]}
        sort="date"
        truncated={false}
      />,
    );
    const controls = typedControls(container);
    expect(controls).toHaveLength(1);
    // No `sm:` step down on this one: the select only exists below 640px, so a
    // smaller desktop size would be dead weight.
    expectClearsFloor(controls[0], "stats sort select");
  });

  it("/dashboard — search and sort, and the density comes back on desktop", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(VIEWS_OFF))),
    );
    const { container } = render(
      <PostsManager
        drafts={[]}
        engagement={new Map()}
        ident="writer.example"
        nextCursor={null}
        onTabChange={() => {}}
        rows={PUBLISHED}
        scheduled={[]}
        tab="published"
      />,
    );
    const controls = typedControls(container);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expectClearsFloor(control, `dashboard ${control.tagName.toLowerCase()}`);
      // The floor is a base-width fix, not a redesign: the writer's own
      // 14px density returns from `sm:` up.
      expect(control.className).toContain("sm:text-sm");
    }
  });
});

const SRC = join(import.meta.dirname, "..");

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".tsx") && !path.startsWith("__tests__"))
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
}

/**
 * Every form control's opening tag in a file, as source text.
 *
 * Brace-aware rather than a regex to `>`: a JSX attribute value routinely
 * contains one (`onChange={(event) => …}`), so the scan ends at the first `>`
 * outside braces and string literals.
 */
function controlTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<(?:input|select|textarea)\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    let i = (match.index ?? 0) + match[0].length;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
      } else if (ch === ">" && depth === 0) {
        break;
      }
    }
    tags.push(source.slice(match.index, i));
  }
  return tags;
}

/** Class tokens in a control's tag. Every string literal in the tag is read,
 * so `className={`min-h-11 ${FIELD_INPUT}`}` and `cn(…)` are covered as well as
 * a plain string — a size token is a size token wherever it is spelled. */
function tokensIn(tag: string): string[] {
  return [...tag.matchAll(/["'`]([^"'`]*)["'`]/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
}

function typeOf(tag: string): string {
  return /type="(\w+)"/.exec(tag)?.[1] ?? "";
}

describe("inventory: no form control anywhere states a base size under 16px", () => {
  it("holds across every surface in the app", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(join(SRC, file), "utf8");
      for (const tag of controlTags(source)) {
        if (NO_CARET.has(typeOf(tag))) continue;
        const small = tokensIn(tag).filter((token) => UNDER_FLOOR.test(token));
        if (small.length > 0) offenders.push(`${file}: ${small.join(" ")}`);
      }
    }
    // A failure here means a control will zoom an iPhone on focus. The fix is
    // `text-base` at base plus `sm:text-sm` — never `maximum-scale=1`.
    expect(offenders).toEqual([]);
  });

  it("is actually looking at the controls it claims to", () => {
    // The scanner is the load-bearing part of the assertion above: a regex that
    // silently matched nothing would pass it forever. /import's two text fields
    // already carried `text-base` before any of this, so they are the fixture.
    const source = readFileSync(join(SRC, "routes/import.tsx"), "utf8");
    const tags = controlTags(source).filter(
      (tag) => !NO_CARET.has(typeOf(tag)),
    );
    expect(tags.length).toBeGreaterThan(1);
    expect(
      tags.filter((tag) => tokensIn(tag).includes("text-base")).length,
    ).toBeGreaterThan(1);
  });
});
