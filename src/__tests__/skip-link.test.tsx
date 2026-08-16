import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppShell } from "#/components/site-chrome";
import { MAIN_CONTENT_ID } from "#/components/skip-link";
import { NotFoundPage } from "#/components/system-pages";
import { WriterSurface } from "#/components/writer-surface";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

/**
 * WCAG 2.4.1. Three things have to hold together or the link is decoration:
 * it must be the FIRST thing a keyboard reaches, it must be hidden until it is
 * reached, and it must point at something that actually exists on the page.
 * Each surface gets all three checked, because the app has three shells and
 * they share no markup.
 */
function skipLink(): HTMLElement {
  return screen.getByRole("link", { name: /skip to content/i });
}

/** The first element in tab order — links, buttons and fields, in DOM order.
 * `sr-only` is clip-based, not `display: none`, so the skip link is here. */
function firstFocusable(): Element | null {
  return document.querySelector("a[href], button, input, select, textarea");
}

function expectTargetExists(link: HTMLElement) {
  const href = link.getAttribute("href");
  expect(href).toBe(`#${MAIN_CONTENT_ID}`);
  const target = document.getElementById(MAIN_CONTENT_ID);
  expect(target).not.toBeNull();
  // Focus has to land, not just the viewport: a fragment jump that leaves
  // focus in the header sends the next Tab back into the nav the visitor
  // just skipped.
  expect(target?.getAttribute("tabindex")).toBe("-1");
}

describe("skip to content — signed-out and marketing chrome", () => {
  it("leads the page, hidden until focused, pointing at the main landmark", () => {
    render(
      <AppShell header={{ variant: "marketing" }}>
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          <h1>Front page</h1>
        </main>
      </AppShell>,
    );
    const link = skipLink();
    expect(firstFocusable()).toBe(link);
    expect(link.className).toContain("sr-only");
    expect(link.className).toContain("focus:not-sr-only");
    expectTargetExists(link);
  });

  it("is ahead of the wordmark, which used to be the first stop", () => {
    render(
      <AppShell header={{ variant: "signed-out" }}>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} />
      </AppShell>,
    );
    const links = screen.getAllByRole("link");
    expect(links[0]).toBe(skipLink());
    expect(links[1]?.textContent).toContain("Goldroad");
  });
});

describe("skip to content — the writer's chrome", () => {
  it("comes before the rail, which is the longest run of nav in the app", () => {
    render(
      <AppShell header={{ variant: "signed-in", ident: "writer.example" }}>
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          <h1>Your posts</h1>
        </main>
      </AppShell>,
    );
    const link = skipLink();
    expect(firstFocusable()).toBe(link);
    // The rail's own destinations follow it, not the other way round.
    const nav = screen.getAllByRole("navigation", { name: "Writer" })[0];
    expect(
      link.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expectTargetExists(link);
  });
});

describe("skip to content — the reading surfaces", () => {
  /**
   * These render none of our chrome, so they were the easy ones to forget.
   * They still lead with the writer's masthead and nav before a word of the
   * post, which is exactly the run this link exists to jump.
   */
  it("is present on an author's own surface", () => {
    render(
      <WriterSurface theme={null}>
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          <h1>An archive</h1>
        </main>
      </WriterSurface>,
    );
    const link = skipLink();
    expect(firstFocusable()).toBe(link);
    expectTargetExists(link);
  });
});

describe("skip to content — real pages carry the target", () => {
  it("404 renders both halves, not just the link", () => {
    render(<NotFoundPage />);
    expectTargetExists(skipLink());
  });

  /**
   * The rendered cases above can only reach the surfaces that mount without
   * route plumbing. Most pages need a loader, and a page that renders the link
   * but no target is a link that scrolls nowhere — so the rest are read from
   * source, the same way the accent budget is (page-accent-budget.test.tsx).
   *
   * Absent on purpose: the chromeless pages — the pending skeleton and the
   * reading surfaces' 404/unavailable notices. They render no chrome, so there
   * is nothing on them to skip and no link is offered.
   */
  it("every chrome-bearing surface's own landmark is the target", () => {
    const SRC = join(import.meta.dirname, "..");
    const SURFACES = [
      "components/document-article.tsx",
      "components/legal-page.tsx",
      "components/system-pages.tsx",
      "routes/@{$handle}.index.tsx",
      "routes/dashboard.tsx",
      "routes/home.tsx",
      "routes/import.tsx",
      "routes/index.tsx",
      "routes/leaving-substack.tsx",
      "routes/open.tsx",
      "routes/report.tsx",
      "routes/settings.tsx",
      "routes/stats.tsx",
      "routes/write.tsx",
    ];
    const missing = SURFACES.filter(
      (file) =>
        !readFileSync(join(SRC, file), "utf8").includes("id={MAIN_CONTENT_ID}"),
    );
    expect(missing).toEqual([]);
  });
});
