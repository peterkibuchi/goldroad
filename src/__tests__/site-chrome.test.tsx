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
 * The command rail (chrome direction 02, with direction 03's dimmed-"Soon"
 * tabs folded in — DECISIONS #62). Desktop rail and mobile tab bar both
 * render in the DOM at once (CSS media queries pick which is visible), so
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

  it("shows Stats and Newsletter as dimmed, non-interactive 'Soon' rows", () => {
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
