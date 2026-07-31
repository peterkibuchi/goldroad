import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeEditor } from "#/components/theme-editor";
import { type BasicTheme, DEFAULT_THEME_HEX } from "#/lib/theme";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const rgb = (r: number, g: number, b: number) => ({ r, g, b });

const savedTheme: BasicTheme = {
  background: rgb(250, 247, 240),
  foreground: rgb(28, 26, 24),
  accent: rgb(20, 84, 140),
  accentForeground: rgb(255, 255, 255),
};

function colourInput(name: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]`,
  );
  if (!input) throw new Error(`no colour input named ${name}`);
  return input;
}

describe("ThemeEditor — four colours, and nothing else", () => {
  it("offers exactly the lexicon's four colours as colour inputs", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    for (const field of [
      "background",
      "foreground",
      "accent",
      "accentForeground",
    ]) {
      expect(colourInput(field).type).toBe("color");
    }
    expect(document.querySelectorAll('input[type="color"]').length).toBe(4);
  });

  it("starts from the app's default palette when the writer has no theme", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    expect(colourInput("background").value).toBe(DEFAULT_THEME_HEX.background);
    expect(colourInput("foreground").value).toBe(DEFAULT_THEME_HEX.foreground);
    expect(colourInput("accent").value).toBe(DEFAULT_THEME_HEX.accent);
  });

  it("starts from the writer's saved theme when they have one", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={savedTheme} />);
    expect(colourInput("background").value).toBe("#faf7f0");
    expect(colourInput("foreground").value).toBe("#1c1a18");
    expect(colourInput("accent").value).toBe("#14548c");
    expect(colourInput("accentForeground").value).toBe("#ffffff");
  });

  it("posts to the single publish handler with the theme intent", () => {
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/api/publish");
    expect(form?.getAttribute("method")).toBe("post");
    expect(
      container.querySelector<HTMLInputElement>('input[name="intent"]')?.value,
    ).toBe("theme");
  });
});

describe("ThemeEditor — the live preview", () => {
  it("shows what a reader gets, through the page's own theme hook", () => {
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={savedTheme} />,
    );
    const preview = container.querySelector("[data-writer-theme]");
    expect(preview).not.toBeNull();
    const style = preview?.getAttribute("style") ?? "";
    expect(style).toContain("--color-paper: rgb(250 247 240)");
    expect(style).toContain("--color-ink: rgb(28 26 24)");
    expect(style).toContain("--color-spot: rgb(20 84 140)");
    // The masthead slot names the writer's publication, not Goldroad.
    expect(screen.getAllByText("The Long Way").length).toBeGreaterThan(0);
  });

  it("repaints as the writer picks, before anything is saved", () => {
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    fireEvent.change(colourInput("background"), {
      target: { value: "#101014" },
    });
    fireEvent.change(colourInput("foreground"), {
      target: { value: "#f4f4f0" },
    });
    const style =
      container.querySelector("[data-writer-theme]")?.getAttribute("style") ??
      "";
    expect(style).toContain("--color-paper: rgb(16 16 20)");
    expect(style).toContain("--color-ink: rgb(244 244 240)");
    // And the hex readout follows the picker.
    expect(screen.getByText("#101014")).toBeTruthy();
  });
});

describe("ThemeEditor — contrast warns, and never blocks", () => {
  it("says nothing while the palette is readable", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={savedTheme} />);
    expect(screen.queryByText(/readable-contrast standard/)).toBeNull();
  });

  it("warns when body text falls under AA against its background", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.change(colourInput("foreground"), {
      target: { value: "#c8c8c8" },
    });
    const warning = screen.getByText(/Your text and background are/);
    expect(warning.textContent).toContain("4.5:1");
    expect(warning.textContent).toContain("won't be able to read");
  });

  it("warns when button text falls under AA against the accent", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.change(colourInput("accent"), { target: { value: "#ffd600" } });
    expect(screen.getByText(/Your button text and accent are/)).toBeTruthy();
  });

  it("warns about both pairs at once when both fail", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.change(colourInput("foreground"), {
      target: { value: "#dcdcdc" },
    });
    fireEvent.change(colourInput("accent"), { target: { value: "#fafafa" } });
    expect(screen.getByText(/Your text and background are/)).toBeTruthy();
    expect(screen.getByText(/Your button text and accent are/)).toBeTruthy();
  });

  it("announces warnings politely rather than as errors", () => {
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    fireEvent.change(colourInput("foreground"), {
      target: { value: "#c8c8c8" },
    });
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    // Not an alert: this is advice a writer may take or leave.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("speaks in ink, not in the accent — it is advice, not an error", () => {
    // The accent carries two meanings in this app: the primary action, and an
    // error. A contrast warning is neither — it remarks on a choice we are
    // about to save anyway. It also sits beside a preview rendering the
    // WRITER'S accent, and two unrelated reds together read as a rendering
    // fault rather than as two meanings.
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    fireEvent.change(colourInput("foreground"), {
      target: { value: "#c8c8c8" },
    });
    const warning = container.querySelector('[aria-live="polite"] p');
    expect(warning).not.toBeNull();
    expect(warning?.className).toContain("text-ink");
    expect(warning?.className).not.toContain("text-spot");
    expect(warning?.className).not.toContain("border-spot");
  });

  it("keeps saving available no matter how unreadable the choice is", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.change(colourInput("foreground"), {
      target: { value: "#ffffff" },
    });
    fireEvent.change(colourInput("accentForeground"), {
      target: { value: "#c52f0f" },
    });
    const save = screen.getByRole("button", { name: "Save colours" });
    expect(save.getAttribute("disabled")).toBeNull();
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ThemeEditor — the way back to the defaults", () => {
  it("submits an explicit reset field rather than re-posting our palette", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={savedTheme} />);
    const reset = screen.getByRole("button", { name: "Use the defaults" });
    expect(reset.getAttribute("type")).toBe("submit");
    expect(reset.getAttribute("name")).toBe("reset");
    expect(reset.getAttribute("value")).toBe("1");
  });

  it("is offered even before a theme has ever been saved", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    expect(
      screen.getByRole("button", { name: "Use the defaults" }),
    ).toBeTruthy();
  });
});

describe("ThemeEditor — accessibility", () => {
  it("names every colour input and describes what it does", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    for (const name of [
      "Background",
      "Text",
      "Accent",
      "Text on accent",
    ] as const) {
      const input = screen.getByLabelText(name);
      expect(input.getAttribute("type")).toBe("color");
      const describedBy = input.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy as string)).not.toBeNull();
    }
  });

  it("groups the colours under one named fieldset", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    expect(screen.getByRole("group", { name: "Colours" })).toBeTruthy();
  });
});
