import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Turning the page on a public archive is a SERVER navigation, on purpose.
 *
 * `?cursor=` responses are what the edge read-cache keys on, and this route's
 * loader reads a third-party PDS over public XRPC — handled in the visitor's
 * browser it loses the cache and the reads are not dependable cross-origin. So
 * "Older posts" here is a plain anchor and the browser does the work, which is
 * the opposite of the posts manager (same label, signed-in page, own data) where
 * the point is NOT to reload.
 */
// Only useLocation is needed (ReportLink in the footer reads it) and it wants a
// live router context this case doesn't set up — stubbed as the reader suites do.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example" }),
}));

import { PublicationView } from "../routes/@{$handle}.index";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const POST = {
  rkey: "3lyk73wxnok2f",
  title: "The morning the presses stopped",
  description: null,
  publishedAt: "2026-01-05T00:00:00.000Z",
  coverPath: null,
  readingMinutes: 4,
};

/**
 * Clicks `el` and reports whether anything cancelled the browser's default
 * action. A router `<Link>` calls preventDefault so it can navigate itself; a
 * plain `<a>` leaves the default alone and the browser loads the page. The
 * listener runs after React's and cancels the default either way, so jsdom is
 * never asked to perform a navigation it hasn't implemented.
 */
function clickWasHandledInPage(el: HTMLElement): boolean {
  let prevented = false;
  const swallow = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", swallow);
  try {
    fireEvent.click(el, { button: 0 });
  } finally {
    document.removeEventListener("click", swallow);
  }
  return prevented;
}

function renderArchive() {
  return render(
    <PublicationView
      ident="writer.example"
      iconPath={null}
      nextCursor="cursor-abc"
      posts={[POST]}
      publication={{ name: "The Long Way" }}
    />,
  );
}

describe("public archive — the page turn stays on the server", () => {
  it("lets the browser follow the link instead of handling it in the page", () => {
    renderArchive();
    const older = screen.getByRole("link", { name: /older posts/i });
    expect(clickWasHandledInPage(older)).toBe(false);
  });

  it("points at the same publication with the next cursor", () => {
    renderArchive();
    expect(
      screen.getByRole("link", { name: /older posts/i }).getAttribute("href"),
    ).toBe("/@writer.example?cursor=cursor-abc");
  });
});
