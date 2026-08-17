import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Route, SubscribedView } from "../routes/subscribed";

/**
 * /subscribed — the page a reader with no JavaScript lands on after posting the
 * capture form, and the only reason that form works without JavaScript at all.
 *
 * What these pin: it says what actually happened (including that nothing sends
 * yet), it never claims a save on the refusal path, its link back is built from a
 * validated identifier rather than from whatever a form field said, and it stays
 * out of search results — this page means something only to the reader who just
 * posted a form.
 */

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const validateSearch = Route.options.validateSearch as (
  search: Record<string, unknown>,
) => { to?: string; failed?: true };

describe("/subscribed — the confirmation", () => {
  it("names the publication and says nothing will arrive yet", () => {
    const { container } = render(<SubscribedView to="writer.example" />);
    const text = container.textContent ?? "";
    expect(text).toContain("@writer.example");
    expect(text).toMatch(/isn't switched on/i);
    expect(text).toMatch(/nothing will arrive/i);
  });

  it("promises no date and offers no invite", () => {
    const text = render(<SubscribedView to="writer.example" />).container
      .textContent;
    expect(text).not.toMatch(/soon|shortly|coming|invit|early access/i);
  });

  it("hands the reader back to the publication they were reading", () => {
    render(<SubscribedView to="writer.example" />);
    const back = screen.getByRole("link", { name: /keep reading/i });
    expect(back.getAttribute("href")).toBe("/@writer.example");
  });

  it("links to how the address is held", () => {
    render(<SubscribedView to="writer.example" />);
    expect(
      screen
        .getByRole("link", { name: /how your address is held/i })
        .getAttribute("href"),
    ).toBe("/privacy");
  });

  it("still reads honestly with no identifier to name", () => {
    const { container } = render(<SubscribedView />);
    expect(container.textContent).toMatch(/this publication/i);
    expect(
      screen.getByRole("link", { name: /keep reading/i }).getAttribute("href"),
    ).toBe("/");
  });
});

describe("/subscribed — the refusal", () => {
  it("says nothing was saved, and does not claim the address is held", () => {
    const { container } = render(<SubscribedView failed to="writer.example" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/nothing was saved/i);
    expect(text).not.toMatch(/has your address/i);
  });

  it("names both things that could have gone wrong", () => {
    // A typo, or a browser with JavaScript off while the spam check is on. The
    // reader can act on either; "something went wrong" is not actionable.
    const text =
      render(<SubscribedView failed to="writer.example" />).container
        .textContent ?? "";
    expect(text).toMatch(/typo/i);
    expect(text).toMatch(/javascript/i);
  });

  it("still offers the way back", () => {
    render(<SubscribedView failed to="writer.example" />);
    expect(
      screen.getByRole("link", { name: /back to/i }).getAttribute("href"),
    ).toBe("/@writer.example");
  });
});

describe("/subscribed — what it accepts in its URL", () => {
  it("keeps a handle or a DID", () => {
    expect(validateSearch({ to: "writer.example" }).to).toBe("writer.example");
    expect(validateSearch({ to: "did:plc:fake2222222222writer2222" }).to).toBe(
      "did:plc:fake2222222222writer2222",
    );
  });

  it("drops anything that isn't one", () => {
    // The value becomes an href. A path or an absolute URL arriving here would
    // make this page a redirect anyone could aim.
    for (const to of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "",
      42,
      undefined,
    ]) {
      expect(validateSearch({ to }).to).toBeUndefined();
    }
  });

  it("reads the refusal flag however the router hands it over", () => {
    // Search values arrive PARSED, not as strings: `?failed=1` reaches
    // validateSearch as the number 1. A string-only check dropped the flag and
    // rendered a refusal as a confirmation, which no assertion on the returned
    // object could show — only a served page did.
    for (const failed of [true, "true", 1, "1"]) {
      expect(validateSearch({ failed }).failed, String(failed)).toBe(true);
    }
    for (const failed of [false, "no", 0, undefined]) {
      expect(validateSearch({ failed }).failed, String(failed)).toBeUndefined();
    }
  });

  it("leaves both fields OUT of a URL that doesn't need them", () => {
    // The router normalizes the URL to whatever this returns, so a `false` here
    // 307s every successful confirmation to `?failed=false` before it renders —
    // and puts the word "failed" in the address bar of a reader who succeeded.
    expect(validateSearch({ to: "writer.example" })).toEqual({
      to: "writer.example",
      failed: undefined,
    });
  });

  it("stays out of search results", () => {
    const head = (Route.options.head as () => { meta: unknown[] })();
    expect(head.meta).toEqual(
      expect.arrayContaining([{ name: "robots", content: "noindex" }]),
    );
  });
});
