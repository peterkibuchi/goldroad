import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MovePublicationNotice } from "#/components/move-publication-notice";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

/**
 * The one-click legacy → trygoldroad.com migration affordance. The hidden
 * fields ARE the contract with /api/publish (intent=migrate + returnTo), so
 * pin them — a drive-by rename breaks the move silently.
 */
describe("MovePublicationNotice", () => {
  it("posts intent=migrate to the single write path with the right returnTo", () => {
    const { container } = render(<MovePublicationNotice returnTo="settings" />);

    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/api/publish");
    expect(form?.getAttribute("method")).toBe("post");
    expect(
      container.querySelector('input[name="intent"]')?.getAttribute("value"),
    ).toBe("migrate");
    expect(
      container.querySelector('input[name="returnTo"]')?.getAttribute("value"),
    ).toBe("settings");
  });

  it("names the destination in the action and explains records stay owned by the writer", () => {
    render(<MovePublicationNotice returnTo="dashboard" />);
    expect(
      screen.getByRole("button", {
        name: /move publication to trygoldroad\.com/i,
      }),
    ).toBeDefined();
    expect(screen.getByText(/in your own repo/i)).toBeDefined();
  });
});
