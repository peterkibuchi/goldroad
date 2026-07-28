import { cleanup, render, screen } from "@testing-library/react";
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
  it("signed-in: renders the writer nav, identity, and sign-out", () => {
    render(
      <SiteHeader
        active="posts"
        ident="writer.bsky.social"
        variant="signed-in"
      />,
    );

    const nav = screen.getByRole("navigation", { name: /writer/i });
    expect(nav).toBeDefined();
    expect(screen.getByRole("link", { name: "Write" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Settings" })).toBeDefined();
    // Import sits between Write and Posts — writers arriving with an archive
    // must find the door without hunting for it.
    const labels = [...nav.querySelectorAll("a")].map((a) => a.textContent);
    expect(labels.indexOf("Import")).toBe(labels.indexOf("Write") + 1);
    expect(labels.indexOf("Posts")).toBe(labels.indexOf("Import") + 1);
    expect(
      screen.getByRole("link", { name: "Import" }).getAttribute("href"),
    ).toBe("/import");
    // The public-page link targets the writer's own publication URL.
    expect(
      screen.getByRole("link", { name: "Public page" }).getAttribute("href"),
    ).toBe("/@writer.bsky.social");
    expect(screen.getByText("writer.bsky.social")).toBeDefined();
    // Sign-out is a POST to /logout, never a GET link.
    const signOut = screen.getByRole("button", { name: /sign out/i });
    expect(signOut.closest("form")?.getAttribute("action")).toBe("/logout");
    expect(signOut.closest("form")?.getAttribute("method")).toBe("post");
  });

  it("signed-in: marks the active section for assistive tech", () => {
    render(
      <SiteHeader
        active="posts"
        ident="writer.bsky.social"
        variant="signed-in"
      />,
    );
    expect(
      screen.getByRole("link", { name: "Posts" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Write" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("signed-in: the Import section carries its own active state", () => {
    render(
      <SiteHeader
        active="import"
        ident="writer.bsky.social"
        variant="signed-in"
      />,
    );
    expect(
      screen.getByRole("link", { name: "Import" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("signed-in: wordmark goes home-for-writers (the dashboard)", () => {
    render(<SiteHeader ident="writer.bsky.social" variant="signed-in" />);
    expect(
      screen.getByRole("link", { name: /goldroad/i }).getAttribute("href"),
    ).toBe("/dashboard");
  });

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

describe("AppShell", () => {
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
