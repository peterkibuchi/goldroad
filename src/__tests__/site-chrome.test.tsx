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

  it("marketing: offers a way in", () => {
    render(<SiteHeader variant="marketing" />);
    // The door was deliberately absent while the product opened by invitation
    // only. It is here now because people are being invited: a writer arriving
    // from a DM, or anyone looking the project over, needs somewhere to go.
    const signIn = screen.getByRole("link", { name: /sign in/i });
    expect(signIn.getAttribute("href")).toBe("/write");
    expect(
      screen.getByRole("link", { name: /goldroad/i }).getAttribute("href"),
    ).toBe("/");
  });

  it("marketing: keeps the sign-in quiet, not the page's accent", () => {
    render(<SiteHeader variant="marketing" />);
    // The landing page spends its one accent on the founding-writers form.
    // Someone who already has an account does not need to be sold to; they
    // need to find the door.
    const signIn = screen.getByRole("link", { name: /sign in/i });
    expect(signIn.className).not.toMatch(/bg-spot|text-spot/);
  });
});

describe("SiteFooter", () => {
  it("carries the ownership promise", () => {
    render(<SiteFooter />);
    expect(screen.getByText(/leave anytime\. lose nothing\./i)).toBeDefined();
  });

  /**
   * The reason-to-believe. Goldroad's central claim is that it can't be taken
   * away; a visitor who can't reach the source, the licence, or the
   * self-hosting path has only our word for it. These assertions exist so that
   * discoverability can't quietly regress again.
   */
  describe("open-source discoverability", () => {
    const REPO = "https://github.com/peterkibuchi/goldroad";

    it("marketing: gives the source, licence, self-hosting and protocol their own column", () => {
      render(<SiteFooter variant="marketing" />);
      const open = screen.getByRole("navigation", { name: "Open" });
      const hrefOf = (name: RegExp) =>
        within(open).getByRole("link", { name }).getAttribute("href");

      expect(hrefOf(/^what's open/i)).toBe("/open");
      expect(hrefOf(/^source on github/i)).toBe(REPO);
      expect(hrefOf(/^license: agpl-3\.0/i)).toBe(`${REPO}/blob/main/LICENSE`);
      expect(hrefOf(/^run your own copy/i)).toBe(
        `${REPO}/blob/main/SELF_HOSTING.md`,
      );
      expect(hrefOf(/^built on the at protocol/i)).toBe("https://atproto.com");
    });

    it("marketing: keeps the product and legal columns, and both decks", () => {
      render(<SiteFooter variant="marketing" />);
      const product = screen.getByRole("navigation", { name: "Product" });
      expect(
        within(product)
          .getByRole("link", { name: /leaving substack/i })
          .getAttribute("href"),
      ).toBe("/leaving-substack");
      const legal = screen.getByRole("navigation", { name: "Legal" });
      for (const [name, href] of [
        [/privacy/i, "/privacy"],
        [/terms/i, "/terms"],
        [/policies/i, "/policies"],
      ] as const) {
        expect(
          within(legal).getByRole("link", { name }).getAttribute("href"),
        ).toBe(href);
      }
      // Deck two survives the columns.
      expect(screen.getByText(/leave anytime\. lose nothing\./i)).toBeDefined();
    });

    it("app: carries the licence and the source inline, one click from every screen", () => {
      render(<SiteFooter />);
      const nav = screen.getByRole("navigation", { name: "Footer" });
      expect(
        within(nav)
          .getByRole("link", { name: /open source \(agpl\)/i })
          .getAttribute("href"),
      ).toBe("/open");
      expect(
        within(nav)
          .getByRole("link", { name: /github/i })
          .getAttribute("href"),
      ).toBe(REPO);
      // Legal stays where writers already look for it.
      expect(
        within(nav)
          .getByRole("link", { name: /privacy/i })
          .getAttribute("href"),
      ).toBe("/privacy");
    });

    it("spends no spot color on either footer (chrome is not the accent moment)", () => {
      const { container } = render(<SiteFooter variant="marketing" />);
      expect(container.innerHTML).not.toContain("spot");
    });

    it("sends off-site footer links to a new tab, safely", () => {
      render(<SiteFooter variant="marketing" />);
      const github = screen.getByRole("link", { name: /^source on github/i });
      expect(github.getAttribute("target")).toBe("_blank");
      expect(github.getAttribute("rel")).toBe("noopener noreferrer");
      // Internal destinations never leave the tab.
      expect(
        screen
          .getByRole("link", { name: /^what's open/i })
          .getAttribute("target"),
      ).toBeNull();
    });
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

  it("gives signed-out surfaces the compact footer, marketing the full one", () => {
    render(
      <AppShell header={{ variant: "signed-out" }}>
        <p>page content</p>
      </AppShell>,
    );
    expect(screen.getByRole("navigation", { name: "Footer" })).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Open" })).toBeNull();

    cleanup();
    render(
      <AppShell header={{ variant: "marketing" }}>
        <p>page content</p>
      </AppShell>,
    );
    expect(screen.getByRole("navigation", { name: "Open" })).toBeDefined();
  });
});

/**
 * The command rail, with its inert "Soon" row folded in. Desktop rail and
 * mobile tab bar both render in the DOM at once (CSS media queries pick which
 * is visible), so
 * every query below scopes to one landmark via `within` rather than the
 * page-wide `screen` — the rail and tab bar both expose an
 * aria-label="Writer" navigation region and repeat the same link labels.
 */
describe("AppShell — signed-in (command rail)", () => {
  function renderShell(active?: "home" | "posts" | "stats" | "settings") {
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

  /** The rail as a whole — nav landmark plus the action above it. */
  function rail() {
    return screen.getByRole("complementary");
  }

  it("renders the writer nav, identity, and sign-out in the rail", () => {
    renderShell("posts");
    const nav = railNav();
    expect(within(nav).getByRole("link", { name: "Home" })).toBeDefined();
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeDefined();
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
        .getByRole("link", { name: "Home" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  /**
   * The information architecture, asserted as a contract.
   *
   * "Write" was a rail row and shouldn't have been: navigation lists places,
   * and writing is the thing you do, not a place you go. Import was a row too,
   * and it's a task performed on your archive — it lives in the posts
   * manager's toolbar now. Both regressions are cheap to reintroduce by adding
   * "one more row", hence these.
   */
  describe("navigation lists places, and only places", () => {
    it("carries exactly Home, Posts, Stats, Settings, in that order", () => {
      renderShell("home");
      const nav = railNav();
      expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
        "Home",
        "Posts",
        "Stats",
        "Settings",
      ]);
      const hrefOf = (name: string) =>
        within(nav).getByRole("link", { name }).getAttribute("href");
      expect(hrefOf("Home")).toBe("/home");
      expect(hrefOf("Posts")).toBe("/dashboard");
      expect(hrefOf("Stats")).toBe("/stats");
      expect(hrefOf("Settings")).toBe("/settings");
    });

    it("keeps Write and Import out of the nav landmark entirely", () => {
      renderShell("posts");
      for (const nav of screen.getAllByRole("navigation", { name: "Writer" })) {
        expect(within(nav).queryByRole("link", { name: "Write" })).toBeNull();
        expect(
          within(nav).queryByRole("link", { name: /^import/i }),
        ).toBeNull();
      }
      // Nothing in the chrome links to the importer any more — it's reached
      // from the posts manager, which is where an archive task belongs.
      expect(screen.queryByRole("link", { name: /^import/i })).toBeNull();
    });

    it("makes Home reachable without knowing the wordmark is a link", () => {
      // The regression this pins: /home used to be reachable only by clicking
      // the wordmark, a convention designers know and writers don't.
      renderShell("posts");
      const nav = railNav();
      expect(
        within(nav).getByRole("link", { name: "Home" }).getAttribute("href"),
      ).toBe("/home");
    });

    it("marks Home active on the overview", () => {
      renderShell("home");
      const nav = railNav();
      expect(
        within(nav).getByRole("link", { name: "Home" }).getAttribute("href"),
      ).toBe("/home");
      expect(
        within(nav)
          .getByRole("link", { name: "Home" })
          .getAttribute("aria-current"),
      ).toBe("page");
    });

    it("lights no row on surfaces that are an act, not a place", () => {
      // The editor and the importer pass no active item: a writer there is
      // doing something, not standing somewhere.
      renderShell();
      for (const nav of screen.getAllByRole("navigation", { name: "Writer" })) {
        for (const link of within(nav).getAllByRole("link")) {
          expect(link.getAttribute("aria-current")).toBeNull();
        }
      }
    });
  });

  /**
   * The primary action. It has to be reachable, obviously not a nav row, and
   * the only accent moment in the chrome — that last one is a deliberate
   * amendment to "chrome spends no spot color", and the thing most likely to
   * be undone by a well-meaning cleanup.
   */
  describe("New post — a primary action, not a destination", () => {
    function primaryAction() {
      return within(rail()).getByRole("link", { name: "New post" });
    }

    it("sits in the rail, above the nav landmark, pointing at the editor", () => {
      renderShell("posts");
      const action = primaryAction();
      expect(action.getAttribute("href")).toBe("/write");
      // Outside the nav landmark: it is not one of the places.
      expect(railNav().contains(action)).toBe(false);
      // And before the destinations in reading and tab order.
      expect(
        action.compareDocumentPosition(railNav()) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("is visually distinct from every navigation row", () => {
      renderShell("posts");
      const action = primaryAction();
      // The accent, spent once, on the writer's most important act.
      expect(action.className).toContain("bg-spot");
      expect(action.className).toContain("text-paper");
      // Navigation stays ink — including the active row's marker.
      for (const link of within(railNav()).getAllByRole("link")) {
        expect(link.className).not.toContain("spot");
      }
    });

    it("is a full-width touch target, keyboard-reachable as a link", () => {
      renderShell("stats");
      const action = primaryAction();
      expect(action.className).toContain("min-h-11");
      expect(action.className).toContain("w-full");
      // A real anchor with a real href — never a div with a click handler.
      expect(action.tagName).toBe("A");
      expect(action.getAttribute("aria-current")).toBeNull();
    });

    it("spends the accent exactly once in the whole chrome", () => {
      renderShell("posts");
      // One spot element per frame: the rail's action, and the mobile tab
      // bar's center slot (only one frame is ever visible at a time). Resting
      // state only — a hover that reaches for spot spends nothing until then.
      const spot = [...document.querySelectorAll("[class]")].filter((el) =>
        el.classList.contains("bg-spot"),
      );
      expect(spot).toHaveLength(2);
      for (const el of spot) {
        expect(el.getAttribute("href")).toBe("/write");
      }
    });

    it("takes the center slot on mobile, labelled for assistive tech", () => {
      renderShell("posts");
      const navs = screen.getAllByRole("navigation", { name: "Writer" });
      const tabBar = navs[1];
      const tabs = [...tabBar.querySelectorAll("a")];
      // Home · Posts · New · Stats · Settings — the action in the middle, the
      // one native pattern for exactly this job.
      expect(tabs.map((a) => a.textContent)).toEqual([
        "Home",
        "Posts",
        "New",
        "Stats",
        "Settings",
      ]);
      const action = within(tabBar).getByRole("link", { name: "New post" });
      expect(action.getAttribute("href")).toBe("/write");
      // Visible text shortens to "New"; the accessible name stays whole and
      // still contains it (voice control can say either).
      expect(action.textContent).toBe("New");
      expect(action.className).toContain("bg-spot");
      // It is an action, so it is never the active tab.
      expect(action.getAttribute("aria-current")).toBeNull();
    });
  });

  it("wordmark goes home-for-writers (the overview)", () => {
    renderShell();
    for (const mark of screen.getAllByRole("link", { name: /goldroad/i })) {
      expect(mark.getAttribute("href")).toBe("/home");
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

  it("carries Stats as a real destination, after Posts", () => {
    renderShell("posts");
    const nav = railNav();
    const stats = within(nav).getByRole("link", { name: "Stats" });
    expect(stats.getAttribute("href")).toBe("/stats");
    const labels = [...nav.querySelectorAll("a")].map((a) => a.textContent);
    expect(labels.indexOf("Stats")).toBe(labels.indexOf("Posts") + 1);
    expect(labels.indexOf("Settings")).toBe(labels.indexOf("Stats") + 1);
  });

  it("marks Stats active on its own surface", () => {
    renderShell("stats");
    const nav = railNav();
    expect(
      within(nav)
        .getByRole("link", { name: "Stats" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: "Posts" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("shows Newsletter as a legible, non-interactive 'Soon' row", () => {
    renderShell("posts");
    const nav = railNav();
    // "Soon" rows are inert — never real links (nowhere to go yet), so they
    // must not appear in the nav's link list at all.
    expect(within(nav).queryByRole("link", { name: /newsletter/i })).toBeNull();
    // But the promise is visible in the rail's static text.
    expect(within(nav).getByText("Newsletter")).toBeDefined();
    expect(within(nav).getAllByText("Soon")).toHaveLength(1);
    // Unavailable must not mean unreadable: the row carries no opacity dimming
    // (which dropped it under the 4.5:1 contrast floor) — the chip and the
    // absent hover response say "not yet" instead.
    const soonRow = within(nav).getByText("Newsletter");
    expect(soonRow.className).not.toContain("opacity");
    expect(soonRow.className).toContain("text-ink-soft");
  });

  it("the mobile tab bar exposes only real destinations, not the Soon rows", () => {
    renderShell("posts");
    const navs = screen.getAllByRole("navigation", { name: "Writer" });
    // Rail nav + mobile tab bar, both present (CSS decides which is shown).
    expect(navs).toHaveLength(2);
    const tabBar = navs[1];
    expect(within(tabBar).getByRole("link", { name: "Home" })).toBeDefined();
    // Stats graduated out of the Soon slot, so it belongs in the tab bar too.
    expect(
      within(tabBar).getByRole("link", { name: "Stats" }).getAttribute("href"),
    ).toBe("/stats");
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
