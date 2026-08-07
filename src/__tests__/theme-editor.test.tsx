import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeEditor } from "#/components/theme-editor";
import {
  type BasicTheme,
  DEFAULT_THEME_HEX,
  parseHexColor,
  STARTER_PALETTES,
  THEME_FIELDS,
} from "#/lib/theme";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const rgb = (r: number, g: number, b: number) => ({ r, g, b });

const savedTheme: BasicTheme = {
  background: rgb(250, 247, 240),
  foreground: rgb(28, 26, 24),
  accent: rgb(20, 84, 140),
  accentForeground: rgb(255, 255, 255),
};

/** A hex as the DOM reports it back: `style` round-trips through the CSS
 * parser, so an inline `#fbf6ec` reads out as `rgb(251, 246, 236)`. Same
 * colour, different spelling — compare the value, not the notation. */
function cssColour(hex: string): string {
  const colour = parseHexColor(hex);
  if (!colour) throw new Error(`bad hex ${hex}`);
  return `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
}

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

describe("ThemeEditor — starter palettes", () => {
  const plum = STARTER_PALETTES.find((p) => p.id === "plum");
  if (!plum) throw new Error("expected a plum palette");

  it("offers the whole curated shelf as one radio group", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    const group = screen.getByRole("group", { name: /Starter palettes/ });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBe(STARTER_PALETTES.length);
    // One shared name, which is what makes it a group a keyboard can walk.
    expect(new Set(radios.map((r) => r.getAttribute("name"))).size).toBe(1);
  });

  it("fills all four colours from one choice", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.click(screen.getByRole("radio", { name: plum.name }));
    for (const field of THEME_FIELDS) {
      expect(colourInput(field).value).toBe(plum.hex[field]);
    }
  });

  it("repaints the preview with the palette, before anything is saved", () => {
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    const night = STARTER_PALETTES.find((p) => p.id === "deep-night");
    if (!night) throw new Error("expected a deep-night palette");
    fireEvent.click(screen.getByRole("radio", { name: night.name }));
    const style =
      container.querySelector("[data-writer-theme]")?.getAttribute("style") ??
      "";
    // #12141a / #e8eaf0 — the palette's own page and text.
    expect(style).toContain("--color-paper: rgb(18 20 26)");
    expect(style).toContain("--color-ink: rgb(232 234 240)");
  });

  it("leaves every colour editable afterwards — a start, not a mode", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.click(screen.getByRole("radio", { name: plum.name }));
    fireEvent.change(colourInput("accent"), { target: { value: "#2f6d3a" } });
    expect(colourInput("accent").value).toBe("#2f6d3a");
    // The three the writer didn't touch stay exactly where the palette put them.
    expect(colourInput("background").value).toBe(plum.hex.background);
    expect(colourInput("foreground").value).toBe(plum.hex.foreground);
    expect(colourInput("accentForeground").value).toBe(
      plum.hex.accentForeground,
    );
  });

  it("stops claiming a palette once the writer has edited away from it", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    const chosen = screen.getByRole("radio", {
      name: plum.name,
    }) as HTMLInputElement;
    fireEvent.click(chosen);
    expect(chosen.checked).toBe(true);
    fireEvent.change(colourInput("accent"), { target: { value: "#2f6d3a" } });
    expect(chosen.checked).toBe(false);
    expect(
      screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
  });

  it("switching palettes replaces the previous one outright", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    const cream = STARTER_PALETTES.find((p) => p.id === "warm-cream");
    if (!cream) throw new Error("expected a warm-cream palette");
    fireEvent.click(screen.getByRole("radio", { name: plum.name }));
    fireEvent.click(screen.getByRole("radio", { name: cream.name }));
    for (const field of THEME_FIELDS) {
      expect(colourInput(field).value).toBe(cream.hex[field]);
    }
    expect(
      screen
        .getAllByRole("radio")
        .filter((r) => (r as HTMLInputElement).checked).length,
    ).toBe(1);
  });

  it("starts with nothing selected — none of them is our palette", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    expect(
      screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
  });

  it("shows a saved theme as its palette when the colours are one", () => {
    const asTheme: BasicTheme = {
      background: rgb(250, 245, 251),
      foreground: rgb(42, 27, 46),
      accent: rgb(109, 47, 122),
      accentForeground: rgb(255, 255, 255),
    };
    render(<ThemeEditor publicationName="The Long Way" theme={asTheme} />);
    expect(
      (screen.getByRole("radio", { name: plum.name }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("keeps the way back to the defaults after a palette is picked", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    fireEvent.click(screen.getByRole("radio", { name: plum.name }));
    const reset = screen.getByRole("button", { name: "Use the defaults" });
    expect(reset.getAttribute("name")).toBe("reset");
    expect(reset.getAttribute("value")).toBe("1");
    // Still the one form, still the one write path.
    expect(document.querySelectorAll("form").length).toBe(1);
  });

  it("previews the actual colours it would apply, not just a name", () => {
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    const specimens = container.querySelectorAll(
      'fieldset [aria-hidden="true"]',
    );
    expect(specimens.length).toBe(STARTER_PALETTES.length);
    const first = specimens[0] as HTMLElement;
    expect(first.getAttribute("style")).toContain(
      cssColour(STARTER_PALETTES[0].hex.background),
    );
    // All four colours are in the specimen, including the pair on the accent.
    const inks = Array.from(first.querySelectorAll("span")).map(
      (el) => el.getAttribute("style") ?? "",
    );
    for (const field of ["foreground", "accent", "accentForeground"] as const) {
      const colour = cssColour(STARTER_PALETTES[0].hex[field]);
      expect(inks.some((style) => style.includes(colour))).toBe(true);
    }
  });
});

describe("ThemeEditor — starter palettes are keyboard-operable", () => {
  // jsdom doesn't implement the browser's own arrow-key handling for a radio
  // group, so what is worth asserting is that this IS a native radio group
  // rather than divs in costume: real inputs, one shared name, in the tab
  // order, and selectable without a pointer. The browser supplies the rest.
  it("is a native group in the tab order, not a grid of styled buttons", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).type).toBe("radio");
      expect((radio as HTMLInputElement).disabled).toBe(false);
      // No tabindex games: the group keeps the browser's own roving behaviour.
      expect(radio.getAttribute("tabindex")).toBeNull();
      expect(radio.getAttribute("aria-hidden")).toBeNull();
    }
  });

  it("selects on keyboard activation, with focus landing on the control", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    const target = STARTER_PALETTES[1];
    const radio = screen.getByRole("radio", {
      name: target.name,
    }) as HTMLInputElement;
    radio.focus();
    expect(document.activeElement).toBe(radio);
    // What Space does on a focused radio, once jsdom's default handling is out
    // of the picture: a click on the focused control.
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);
    for (const field of THEME_FIELDS) {
      expect(colourInput(field).value).toBe(target.hex[field]);
    }
  });

  it("names every option in words, never by swatch alone", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    for (const palette of STARTER_PALETTES) {
      expect(screen.getByRole("radio", { name: palette.name })).toBeTruthy();
    }
  });

  it("explains what picking one does, and points the group at it", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={null} />);
    const group = screen.getByRole("group", { name: /Starter palettes/ });
    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const help = document.getElementById(describedBy as string);
    expect(help?.textContent).toContain("fill the four colours below");
  });

  it("spends no accent on the picker — the save button already has it", () => {
    // DESIGN.md: one accent moment per view. The picker is ink and rules.
    const { container } = render(
      <ThemeEditor publicationName="The Long Way" theme={null} />,
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset?.innerHTML).not.toContain("bg-spot");
    expect(fieldset?.innerHTML).not.toContain("text-spot");
    expect(fieldset?.innerHTML).not.toContain("border-spot");
    expect(fieldset?.innerHTML).not.toContain("rounded");
    expect(fieldset?.innerHTML).not.toContain("shadow");
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

  // `theme={null}` is ambiguous on its own: it means "no theme saved" OR "we
  // couldn't read the record". In the second case the editor is showing the
  // defaults, and both buttons would write those over colours the writer did
  // choose — a save writing our palette, and the reset dropping theirs. The
  // server can't catch this one, because ITS read succeeds.
  it("cannot be saved when the publication couldn't be read", () => {
    render(
      <ThemeEditor disabled publicationName="The Long Way" theme={null} />,
    );
    const save = screen.getByRole("button", { name: "Save colours" });
    const reset = screen.getByRole("button", { name: "Use the defaults" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((reset as HTMLButtonElement).disabled).toBe(true);
  });

  it("is saveable in the ordinary case", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={savedTheme} />);
    const save = screen.getByRole("button", { name: "Save colours" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("theme editor — the swatches are the only target", () => {
  it("gives every colour picker a 44px hit area", () => {
    render(<ThemeEditor publicationName="The Long Way" theme={savedTheme} />);
    // The native picker carries its own hex entry and eyedropper, so there is no
    // second field beside it, and the label is a ~20px run of text that cannot
    // rescue a 40px swatch. Class string, for want of layout in jsdom.
    for (const field of THEME_FIELDS)
      expect(colourInput(field).className, field).toContain("size-11");
  });
});
