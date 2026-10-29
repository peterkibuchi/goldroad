import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Route } from "#/routes/leaving-substack";
import { routeComponent } from "./support/route-component";

const LeavingSubstack = routeComponent(Route);

// Tests live outside `src/routes/` so the file-based router
// does not pick them up as route files.
// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("LeavingSubstack", () => {
  it("promises no subscriber or card continuity", () => {
    const { container } = render(<LeavingSubstack />);
    const shown = (container.textContent ?? "").replace(/\s+/g, " ");

    // Carrying Substack's paying subscribers over would need a payments
    // platform this project can't operate, so the page must not imply it.
    expect(shown).not.toMatch(
      /same stripe account|keep paying|same cards|connect that same account|subscribers will come with you/i,
    );
    expect(
      screen.getByRole("heading", {
        name: "Paid subscriptions, on a processor you hold.",
      }),
    ).toBeDefined();
  });

  it("keeps the reader-payments row on the writer's own processor, and unshipped", () => {
    render(<LeavingSubstack />);

    const row = screen
      .getByRole("rowheader", { name: /reader payments/i })
      .closest("tr");

    expect(row?.textContent).toMatch(/payment processor you hold yourself/i);
    expect(row?.textContent).not.toMatch(/stripe/i);
    expect(row?.textContent).toMatch(/on the roadmap/i);
  });

  it("labels every unshipped capability, in the table and in prose", () => {
    render(<LeavingSubstack />);

    // Per row rather than a page-wide count: a global count breaks whenever an
    // unrelated section mentions the roadmap.
    for (const label of ["Newsletters", "Reader payments"]) {
      const row = screen.getByRole("rowheader", { name: label }).closest("tr");
      expect(row?.textContent).toMatch(/on the roadmap/i);
    }

    // The payments section says it isn't built before saying what it will be.
    const payments =
      screen.getByText(/paid subscriptions aren't built yet/i).textContent ??
      "";
    expect(payments.indexOf("aren't built yet")).toBeGreaterThan(-1);
    expect(payments.indexOf("aren't built yet")).toBeLessThan(
      payments.indexOf("takes 0%"),
    );
  });

  it("marks its own header link as the current page", () => {
    render(<LeavingSubstack />);
    expect(
      within(screen.getByRole("banner"))
        .getByRole("link", { name: "Leaving Substack?" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("leads with the archive, not the readers", () => {
    render(<LeavingSubstack />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /^Bring your archive\./,
    );
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
