import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorPage, NotFoundPage } from "../components/system-pages";
import { captureException } from "../lib/posthog";

vi.mock("../lib/posthog", () => ({ captureException: vi.fn() }));

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

// De-cosplay rule: system/UI messages carry ZERO press metaphor — the visual
// system holds the register, the words hold the facts.
const METAPHOR = /set in type|press jammed|pressroom|proof no/i;

describe("system pages — plain, outcome-first copy", () => {
  it("404 says what happened in plain words, with a way back", () => {
    const { container } = render(<NotFoundPage />);
    expect(
      screen.getByRole("heading", {
        name: "There's nothing at this address.",
      }),
    ).toBeTruthy();
    const back = screen.getByRole("link", { name: "Go to the front page" });
    expect(back.getAttribute("href")).toBe("/");
    expect(container.textContent).not.toMatch(METAPHOR);
  });

  it("error page names the problem, reassures about the data, offers retry", () => {
    const { container } = render(<ErrorPage error={new Error("boom")} />);
    expect(
      screen.getByRole("heading", { name: "Something went wrong." }),
    ).toBeTruthy();
    expect(container.textContent).toContain(
      "Your writing is safe in your own data repo",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to the front page" }),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(METAPHOR);
  });
});

describe("error page reporting", () => {
  it("reports the error it caught, which capture_exceptions never sees", () => {
    const error = new Error("loader failed");
    render(<ErrorPage error={error} />);
    expect(captureException).toHaveBeenCalledWith(error);
  });
});
