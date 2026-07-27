import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ExternalLink } from "#/components/external-link";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("ExternalLink", () => {
  it("opens in a new tab without handing over the opener", () => {
    render(
      <ExternalLink className="underline" href="https://bsky.app">
        Create a free account
      </ExternalLink>,
    );
    const link = screen.getByRole("link", { name: /create a free account/i });
    expect(link.getAttribute("href")).toBe("https://bsky.app");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // Ordinary anchor props pass straight through.
    expect(link.getAttribute("class")).toBe("underline");
  });

  it("tells screen readers the tab is new — the ↗ glyph is visual-only", () => {
    render(<ExternalLink href="https://bsky.app">Announced ↗</ExternalLink>);
    const link = screen.getByRole("link");
    expect(link.textContent).toContain("(opens in new tab)");
    expect(screen.getByText(/opens in new tab/i).className).toContain(
      "sr-only",
    );
  });

  it("callers cannot accidentally weaken target or rel", () => {
    render(
      <ExternalLink href="https://example.com" rel="" target="_self">
        tempting override
      </ExternalLink>,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
