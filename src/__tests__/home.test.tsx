import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Landing } from "#/routes/index";

// Tests live outside `src/routes/` so the file-based router
// does not pick them up as route files.
// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("Landing", () => {
  it("renders the hero and the signup form", () => {
    render(<Landing />);

    // The distribution-first hero.
    expect(
      screen.getByRole("heading", {
        name: /your followers are already your readers/i,
      }),
    ).toBeDefined();
    // Signup form: labelled email + submit.
    expect(screen.getByLabelText(/email address/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /count me in/i })).toBeDefined();
  });

  it("leads the hero with the way in, and keeps the list as the second path", () => {
    render(<Landing />);
    const signIn = screen.getByRole("link", { name: "Sign in with Bluesky" });
    const join = screen.getAllByRole("link", {
      name: "Join the founding writers",
    });

    // /home signs a visitor in, or takes a signed-in one to their publication.
    expect(signIn.getAttribute("href")).toBe("/home");
    expect(signIn.className).toMatch(/\bbg-spot\b/);
    // The hero's list link is the quiet one: one primary action per view.
    expect(join).toHaveLength(1);
    expect(join[0].getAttribute("href")).toBe("#join");
    expect(join[0].className).not.toMatch(/\bbg-spot\b/);
    // Primary first in reading order.
    expect(
      signIn.compareDocumentPosition(join[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the honeypot field out of the accessibility tree", () => {
    render(<Landing />);
    // The honeypot (gr_extra) is aria-hidden, so the only textbox the a11y
    // tree exposes is the real email field. If the honeypot ever leaked into
    // the tree, this count would rise and the test would fail.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});
