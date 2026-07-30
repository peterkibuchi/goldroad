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
