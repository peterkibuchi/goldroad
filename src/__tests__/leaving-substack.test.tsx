import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LeavingSubstack } from "#/routes/leaving-substack";

// Tests live outside `src/routes/` so the file-based router
// does not pick them up as route files.
// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("LeavingSubstack", () => {
  it("makes the Stripe-portability claim the page's payments argument", () => {
    render(<LeavingSubstack />);

    expect(
      screen.getByRole("heading", {
        name: /your paying subscribers will come with you/i,
      }),
    ).toBeDefined();
  });

  it("keeps the reader-payments row marked as unshipped", () => {
    render(<LeavingSubstack />);

    const row = screen
      .getByRole("rowheader", { name: /reader payments/i })
      .closest("tr");

    // The row carries the subscriber-continuity point...
    expect(row?.textContent).toMatch(/same stripe account/i);
    // ...and never without the honest "not shipped" marker beside it.
    expect(row?.textContent).toMatch(/on the roadmap/i);
  });

  it("labels every unshipped capability, in the table and in prose", () => {
    render(<LeavingSubstack />);

    // Every table row promising an unshipped capability carries the marker.
    // Asserting per-row rather than counting markers page-wide: a global count
    // breaks whenever any unrelated section mentions the roadmap, which teaches
    // the next person to bump the number instead of checking the claim.
    for (const label of ["Newsletters", "Reader payments"]) {
      const row = screen.getByRole("rowheader", { name: label }).closest("tr");
      expect(row?.textContent).toMatch(/on the roadmap/i);
    }

    // Payments prose stays future-tense: no present-tense "runs through" /
    // "connect your Stripe today" phrasing may creep in.
    const payments = screen.getByText(
      /substack charges your paid subscriptions through stripe/i,
    ).textContent;
    expect(payments).toMatch(/when reader payments ship/i);
  });
});

/**
 * The comparison on a phone.
 *
 * Below 640px the 576px table showed 47% of itself — the whole Substack column
 * off-screen, no sticky header, no affordance saying there was more. On the page
 * whose argument IS the comparison, so the same rows also render stacked.
 *
 * Both forms are in the DOM here: jsdom applies no CSS, so what these assert is
 * that the two forms carry identical content, which is the part that rots. The
 * breakpoint switch itself is a class-string assertion at the end — there is no
 * layout in jsdom to read it off, and a wrong breakpoint would show both.
 */
describe("LeavingSubstack — the comparison stacks on a phone", () => {
  /** The stacked form. Selected by its label rather than by tag: the page has
   * other `<dl>`s, and this is the one that replaces the table's caption for
   * anyone who only ever sees the stacked form. */
  function stackedList(container: HTMLElement) {
    const list = container.querySelector<HTMLElement>("dl[aria-label]");
    if (!list) throw new Error("stacked comparison list not rendered");
    return list;
  }

  function rowBlocks(list: HTMLElement) {
    return [...list.querySelectorAll("dt")].map((dt) => {
      const block = dt.parentElement;
      if (!block) throw new Error("a stacked row has no block");
      return block;
    });
  }

  it("renders the same rows, in the same order, as the table", () => {
    const { container } = render(<LeavingSubstack />);
    const tableLabels = [...container.querySelectorAll("table tbody th")].map(
      (th) => th.textContent,
    );
    const listLabels = [...stackedList(container).querySelectorAll("dt")].map(
      (dt) => dt.textContent,
    );

    expect(tableLabels.length).toBeGreaterThan(0);
    expect(listLabels).toEqual(tableLabels);
  });

  it("carries both sides of every row, roadmap markers and all", () => {
    const { container } = render(<LeavingSubstack />);
    const rows = [...container.querySelectorAll("table tbody tr")];
    const blocks = rowBlocks(stackedList(container));
    expect(blocks).toHaveLength(rows.length);

    rows.forEach((row, i) => {
      const cells = row.querySelectorAll("td");
      const sides = blocks[i].querySelectorAll("dd");
      // Each side is the table cell's own text behind a visible label — so a
      // value that changes in one form cannot stay stale in the other, and the
      // Substack column a phone could not reach is present in full.
      expect(sides).toHaveLength(2);
      expect(sides[0].textContent).toBe(`Goldroad${cells[0].textContent}`);
      expect(sides[1].textContent).toBe(`Substack${cells[1].textContent}`);
    });

    // Unshipped stays marked in both forms, and something is actually marked —
    // an empty set would pass the parity check above while saying nothing.
    const marked = (nodes: Element[]) =>
      nodes
        .filter((node) => /on the roadmap/i.test(node.textContent ?? ""))
        .map((node) => node.querySelector("th, dt")?.textContent);
    expect(marked(rows).length).toBeGreaterThan(0);
    expect(marked(blocks)).toEqual(marked(rows));
  });

  it("shows one form at a time, and spends no accent doing it", () => {
    const { container } = render(<LeavingSubstack />);
    const list = stackedList(container);
    const scroller = container.querySelector("table")?.parentElement;

    // Class strings, for want of layout in jsdom. The scroller — not the table
    // — is what hides, because it carries the section's top margin.
    expect(scroller?.className).toMatch(/\bhidden\b/);
    expect(scroller?.className).toMatch(/\bsm:block\b/);
    expect(list.className).toMatch(/\bsm:hidden\b/);

    // docs/DESIGN.md: one accent moment per view. The table spends one on its
    // Goldroad column head; twelve stacked rows must not spend twelve.
    expect(list.querySelectorAll('[class*="spot"]')).toHaveLength(0);
  });
});
