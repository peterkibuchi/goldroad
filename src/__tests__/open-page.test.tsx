import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OpenPage, Route } from "#/routes/open";

// Tests live outside `src/routes/` so the file-based router
// does not pick them up as route files.
// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const REPO = "https://github.com/peterkibuchi/goldroad";

describe("/open — the trust surface", () => {
  it("puts the source one click away, as the page's primary action", () => {
    render(<OpenPage />);
    const cta = screen.getByRole("link", {
      name: /read the source on github/i,
    });
    expect(cta.getAttribute("href")).toBe(REPO);
    // The page's single accent moment belongs to this link.
    expect(cta.className).toContain("bg-spot");
  });

  it("names the licence and links the actual text of it", () => {
    render(<OpenPage />);
    expect(screen.getAllByText(/AGPL-3\.0-only/).length).toBeGreaterThan(0);
    const licence = screen.getAllByRole("link", { name: /licence|AGPL-3\.0/i });
    expect(
      licence.some(
        (link) => link.getAttribute("href") === `${REPO}/blob/main/LICENSE`,
      ),
    ).toBe(true);
  });

  it("answers the contribution question: DCO, no CLA, no relicensing", () => {
    render(<OpenPage />);
    const heading = screen.getByRole("heading", {
      name: /dco, no cla, no relicensing/i,
    });
    const section = heading.closest("section");
    expect(section?.textContent).toMatch(/no contributor licence agreement/i);
    // The point isn't the acronym — it's that nobody *can* relicense the core.
    expect(section?.textContent).toMatch(/proprietary/i);
  });

  it("credits the shared record format instead of claiming it", () => {
    render(<OpenPage />);
    const heading = screen.getByRole("heading", {
      name: /built on shared formats/i,
    });
    const section = heading.closest("section");
    expect(section?.textContent).toMatch(/Leaflet, pckt\.blog and Offprint/);
    // A format of our own is a future promise, and marked as one.
    expect(section?.textContent).toMatch(/CC0/);
  });

  it("offers self-hosting without overselling how supported it is", () => {
    render(<OpenPage />);
    const heading = screen.getByRole("heading", { name: /run your own copy/i });
    const section = heading.closest("section");
    expect(
      within(section as HTMLElement)
        .getByRole("link", { name: /self_hosting\.md/i })
        .getAttribute("href"),
    ).toBe(`${REPO}/blob/main/SELF_HOSTING.md`);
    // Honesty rule: unshipped support is never written in the present tense.
    expect(section?.textContent).toMatch(/community-supported/i);
    expect(section?.textContent).toMatch(/on the roadmap, not shipped/i);
  });

  it("states the 0% take and marks reader payments as unbuilt", () => {
    render(<OpenPage />);
    const heading = screen.getByRole("heading", { name: /who pays/i });
    const section = heading.closest("section");
    expect(section?.textContent).toMatch(/0% of what readers pay writers/i);
    expect(section?.textContent).toMatch(/reader payments aren't built yet/i);
  });

  it("carries the marketing footer, so the page it explains links back", () => {
    render(<OpenPage />);
    expect(screen.getByRole("navigation", { name: "Open" })).toBeDefined();
  });
});

describe("/open — head metadata", () => {
  type HeadFn = () => {
    meta?: Array<Record<string, string>>;
    links?: Array<Record<string, string>>;
  };
  const head = (Route.options as unknown as { head: HeadFn }).head;

  it("titles and describes itself for the people who arrive by search", () => {
    const { meta } = head();
    expect(meta).toContainEqual({ title: "Open source — Goldroad" });
    const description = meta?.find((tag) => tag.name === "description");
    expect(description?.content).toMatch(/AGPL-3\.0-only/);
  });

  it("mints its canonical and og:url from the canonical origin", () => {
    const { meta, links } = head();
    // Never the request origin: a preview hostname in a shared link is
    // permanent in a way the deployment isn't.
    expect(links).toContainEqual({
      rel: "canonical",
      href: "https://trygoldroad.com/open",
    });
    expect(meta).toContainEqual({
      property: "og:url",
      content: "https://trygoldroad.com/open",
    });
    expect(meta).toContainEqual({
      property: "og:title",
      content: "Open source — Goldroad",
    });
  });
});
