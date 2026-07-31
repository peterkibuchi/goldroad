import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// write.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { SignIn } from "../routes/write";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("/write sign-in panel — designed login errors", () => {
  it("shows the invalid-handle notice and preserves the entered handle", () => {
    render(<SignIn error="invalid_handle" handle="not_a_handle" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("doesn't look like a Bluesky handle");
    expect(alert.textContent).toContain("name.bsky.social");
    const input = screen.getByLabelText<HTMLInputElement>("Your handle");
    expect(input.value).toBe("not_a_handle");
  });

  it("unresolvable handle gets its own what-to-do-next copy", () => {
    render(<SignIn error="handle_not_found" handle="ghost.bsky.social" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "couldn't find that handle on the network",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Your handle").value).toBe(
      "ghost.bsky.social",
    );
  });

  it("renders clean without an error", () => {
    render(<SignIn error={undefined} handle={undefined} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Your handle").value).toBe(
      "",
    );
  });

  it("sends newcomers to Bluesky in a new tab (their form entry survives)", () => {
    render(<SignIn error={undefined} handle={undefined} />);
    const link = screen.getByRole("link", { name: /create a free account/i });
    expect(link.getAttribute("href")).toBe("https://bsky.app");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

/**
 * Where sign-in sends the writer afterwards.
 *
 * This panel is the app's only sign-in form, and every signed-in surface bounces
 * its anonymous visitors here. It used to post a hardcoded `returnTo=/write`, so
 * a writer who clicked Stats and signed in arrived in a blank editor. The form
 * now carries the destination it was given, and defaults to the editor only for
 * someone who actually came to /write.
 */
describe("/write sign-in panel — where it sends the writer", () => {
  function returnToField(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>('input[name="returnTo"]');
  }

  it("defaults to the editor for a writer who came here to write", () => {
    render(<SignIn error={undefined} handle={undefined} />);
    expect(returnToField()?.value).toBe("/write");
  });

  it("carries the destination a bounced writer was actually headed for", () => {
    render(<SignIn error={undefined} handle={undefined} returnTo="/home" />);
    expect(returnToField()?.value).toBe("/home");
    cleanup();
    render(<SignIn error={undefined} handle={undefined} returnTo="/stats" />);
    expect(returnToField()?.value).toBe("/stats");
  });

  it("keeps the destination through a failed attempt", () => {
    // The error round-trip goes back through /login's redirect, so losing
    // returnTo here would silently reroute a writer who mistyped their handle.
    render(
      <SignIn error="invalid_handle" handle="not_a_handle" returnTo="/home" />,
    );
    expect(returnToField()?.value).toBe("/home");
    // It posts to /login, which is where the open-redirect guard runs.
    expect(returnToField()?.closest("form")?.getAttribute("action")).toBe(
      "/login",
    );
  });
});
