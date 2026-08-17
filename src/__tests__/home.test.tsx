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

  it("keeps the honeypot field out of the accessibility tree", () => {
    render(<Landing />);
    // The honeypot (gr_extra) is aria-hidden, so the only textbox the a11y
    // tree exposes is the real email field. If the honeypot ever leaked into
    // the tree, this count would rise and the test would fail.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});
