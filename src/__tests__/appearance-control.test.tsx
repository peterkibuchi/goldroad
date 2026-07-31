/**
 * Appearance is three-way, stored locally, and scoped to writer surfaces.
 *
 * The scoping is the part worth pinning: a publication's pages belong to its
 * writer, and marketing is printed once. If this control ever starts theming
 * the whole document rather than the writer chrome, that is a product decision
 * being made by accident.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppearanceControl } from "../components/appearance-control";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

beforeEach(() => {
  // jsdom has no matchMedia; the control asks for the system preference.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

describe("AppearanceControl", () => {
  it("offers System, Light and Dark — not a two-state switch", () => {
    render(<AppearanceControl />);
    // "System" is the honest default and the one most people want; collapsing
    // it into a toggle forces a choice nobody asked to make.
    for (const label of ["System", "Light", "Dark"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("defaults to System when nothing has been chosen", () => {
    render(<AppearanceControl />);
    expect(
      screen
        .getByRole("button", { name: "System" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("restores a stored choice", () => {
    localStorage.setItem("gr-appearance", "dark");
    render(<AppearanceControl />);
    expect(
      screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("says plainly that a publication keeps its own appearance", () => {
    render(<AppearanceControl />);
    // The writer owns their pages; this control must never imply otherwise.
    expect(
      screen.getByText(/your publication's own pages keep the appearance/i),
    ).toBeTruthy();
  });
});
