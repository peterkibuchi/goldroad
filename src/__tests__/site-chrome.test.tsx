import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppShell, SiteFooter, SiteHeader } from "#/components/site-chrome";
import {
  ErrorPage,
  NotFoundPage,
  PendingPage,
} from "#/components/system-pages";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("SiteHeader", () => {
  it("signed-out: sends the wordmark home and exposes no /write path", () => {
    render(<SiteHeader variant="signed-out" />);
    expect(
      screen.getByRole("link", { name: /goldroad/i }).getAttribute("href"),
    ).toBe("/");
    // Pre-launch: chrome offers no public route into the app.
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /write/i })).toBeNull();
  });

  it("marketing: shows the status note and no sign-in link", () => {
    render(<SiteHeader variant="marketing" />);
    expect(screen.getByText(/opening soon/i)).toBeDefined();
    // The marketing header intentionally carries no sign-in link.
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(
      screen.getByRole("link", { name: /goldroad/i }).getAttribute("href"),
    ).toBe("/");
  });
});

describe("SiteFooter", () => {
  it("carries the ownership promise", () => {
    render(<SiteFooter />);
    expect(screen.getByText(/leave anytime\. lose nothing\./i)).toBeDefined();
  });
});

describe("AppShell — marketing/signed-out", () => {
  it("frames content between header and footer", () => {
    render(
      <AppShell header={{ variant: "signed-out" }}>
        <p>page content</p>
      </AppShell>,
    );
    expect(screen.getByText("page content")).toBeDefined();
    expect(screen.getByRole("banner")).toBeDefined();
    expect(screen.getByRole("contentinfo")).toBeDefined();
  });
});

/**
 * The command rail, with its inert "Soon" rows folded in. Desktop rail and
 * mobile tab bar both render in the DOM at once (CSS media queries pick which
 * is visible), so
 * every query below scopes to one landmark via `within` rather than the
 * page-wide `screen` — the rail and tab bar both expose an
 * aria-label="Writer" navigation region and repeat the same link labels.
 */
describe("AppShell — signed-in (command rail)", () => {
  function renderShell(active?: "write" | "import" | "posts" | "settings") {
    render(
      <AppShell
        header={{ active, ident: "writer.bsky.social", variant: "signed-in" }}
      >
        <p>dashboard content</p>
      </AppShell>,
    );
  }

  function railNav() {
    const [rail] = screen.getAllByRole("navigation", { name: "Writer" });
    return rail;
  }

  it("renders the writer nav, identity, and sign-out in the rail", () => {
    renderShell("posts");
    const nav = railNav();
    expect(within(nav).getByRole("link", { name: "Write" })).toBeDefined();
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeDefined();
    // Import sits between Write and Posts — writers arriving with an archive
    // must find the door without hunting for it.
    const labels = [...nav.querySelectorAll("a")].map((a) => a.textContent);
    expect(labels.indexOf("Import")).toBe(labels.indexOf("Write") + 1);
    expect(labels.indexOf("Posts")).toBe(labels.indexOf("Import") + 1);
    expect(
      within(nav).getByRole("link", { name: "Import" }).getAttribute("href"),
    ).toBe("/import");
    // Identity, public-page link, and sign-out live in the rail's bottom
    // cluster, not the nav landmark.
    expect(screen.getAllByText("writer.bsky.social")[0]).toBeDefined();
    const publicPageLinks = screen.getAllByRole("link", {
      name: "Public page",
    });
    expect(publicPageLinks.length).toBeGreaterThan(0);
    for (const link of publicPageLinks) {
      expect(link.getAttribute("href")).toBe("/@writer.bsky.social");
    }
    // Sign-out is a POST to /logout, never a GET link.
    const signOuts = screen.getAllByRole("button", { name: /sign out/i });
    expect(signOuts.length).toBeGreaterThan(0);
    for (const signOut of signOuts) {
      expect(signOut.closest("form")?.getAttribute("action")).toBe("/logout");
      expect(signOut.closest("form")?.getAttribute("method")).toBe("post");
    }
  });

  it("marks the active section for assistive tech", () => {
    renderShell("posts");
    const nav = railNav();
    expect(
      within(nav)
        .getByRole("link", { name: "Posts" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: "Write" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("the Import section carries its own active state", () => {
    renderShell("import");
    const nav = railNav();
    expect(
      within(nav)
        .getByRole("link", { name: "Import" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("wordmark goes home-for-writers (the dashboard)", () => {
    renderShell();
    for (const mark of screen.getAllByRole("link", { name: /goldroad/i })) {
      expect(mark.getAttribute("href")).toBe("/dashboard");
    }
  });

  it("anchors the rail to the viewport, not the document", () => {
    renderShell("settings");
    // Regression: the rail used to stretch to the document's height, which
    // scrolled its nav off the top and stranded the identity cluster far below
    // the fold on any long page. It must be exactly one viewport tall and
    // pinned to the top of the scrollport.
    const rail = screen.getByRole("complementary");
    for (const cls of ["sticky", "top-0", "h-dvh"]) {
      expect(rail.className.split(" ")).toContain(cls);
    }
    // The shell itself never scrolls; only the nav region may, and only if the
    // rows outgrow the viewport. Anything else means a second scrollbar.
    expect(rail.className).not.toContain("overflow");
    const nav = railNav();
    expect(nav.className.split(" ")).toContain("overflow-y-auto");
    // Identity sits at the bottom of the rail's full-height column.
    const identity = screen
      .getAllByText("writer.bsky.social")[0]
      .closest("div")?.parentElement;
    expect(identity?.className.split(" ")).toContain("mt-auto");
  });

  it("spends no spot color on the active-section marker", () => {
    renderShell("posts");
    // The vermillion accent is scarce — one moment per view — and it belongs to
    // the page's primary action, not to persistent chrome.
    const navs = screen.getAllByRole("navigation", { name: "Writer" });
    for (const nav of navs) {
      const active = within(nav).getByRole("link", { name: "Posts" });
      expect(active.className).toContain("border-ink");
      expect(active.className).not.toContain("spot");
    }
  });

  it("shows Stats and Newsletter as legible, non-interactive 'Soon' rows", () => {
    renderShell("posts");
    const nav = railNav();
    // "Soon" rows are inert — never real links (nowhere to go yet), so they
    // must not appear in the nav's link list at all.
    expect(within(nav).queryByRole("link", { name: /stats/i })).toBeNull();
    expect(within(nav).queryByRole("link", { name: /newsletter/i })).toBeNull();
    // But the promise is visible in the rail's static text.
    expect(within(nav).getByText("Stats")).toBeDefined();
    expect(within(nav).getByText("Newsletter")).toBeDefined();
    expect(within(nav).getAllByText("Soon")).toHaveLength(2);
    // Unavailable must not mean unreadable: the rows carry no opacity dimming
    // (which dropped them under the 4.5:1 contrast floor) — the chip and the
    // absent hover response say "not yet" instead.
    const soonRow = within(nav).getByText("Stats");
    expect(soonRow.className).not.toContain("opacity");
    expect(soonRow.className).toContain("text-ink-soft");
  });

  it("the mobile tab bar exposes only real destinations, not the Soon rows", () => {
    renderShell("posts");
    const navs = screen.getAllByRole("navigation", { name: "Writer" });
    // Rail nav + mobile tab bar, both present (CSS decides which is shown).
    expect(navs).toHaveLength(2);
    const tabBar = navs[1];
    expect(within(tabBar).getByRole("link", { name: "Write" })).toBeDefined();
    expect(within(tabBar).queryByText("Soon")).toBeNull();
  });
});

describe("system pages", () => {
  it("404 names itself and routes back to the front page", () => {
    render(<NotFoundPage />);
    expect(screen.getByText(/404/)).toBeDefined();
    expect(
      screen.getByRole("link", { name: /front page/i }).getAttribute("href"),
    ).toBe("/");
  });

  it("error page offers recovery and never blames the writer", () => {
    render(<ErrorPage error={new Error("boom")} />);
    expect(screen.getByRole("button", { name: /try again/i })).toBeDefined();
    expect(screen.getByText(/safe in your own data repo/i)).toBeDefined();
  });

  it("pending skeleton is announced to assistive tech", () => {
    render(<PendingPage />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });
});
