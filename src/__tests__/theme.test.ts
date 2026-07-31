import { describe, expect, it } from "vitest";

import {
  AA_CONTRAST,
  type BasicTheme,
  contrastRatio,
  DEFAULT_THEME_HEX,
  formatRatio,
  parseHexColor,
  parseTheme,
  parseThemeForm,
  themeRecord,
  themeStyle,
  themeWarnings,
  toHexColor,
} from "#/lib/theme";

const rgb = (r: number, g: number, b: number) => ({ r, g, b });

/** A readable theme: near-black on white, vermillion accent with white on it. */
const readable: BasicTheme = {
  background: rgb(255, 255, 255),
  foreground: rgb(22, 22, 22),
  accent: rgb(197, 47, 15),
  accentForeground: rgb(255, 255, 255),
};

/** The wire shape a PDS actually returns — $type tags and all. */
const wireTheme = {
  $type: "site.standard.theme.basic",
  accent: { $type: "site.standard.theme.color#rgb", r: 197, g: 47, b: 15 },
  accentForeground: {
    $type: "site.standard.theme.color#rgb",
    r: 255,
    g: 255,
    b: 255,
  },
  background: {
    $type: "site.standard.theme.color#rgb",
    r: 255,
    g: 255,
    b: 255,
  },
  foreground: { $type: "site.standard.theme.color#rgb", r: 22, g: 22, b: 22 },
};

describe("parseTheme — the one door for untrusted colour", () => {
  it("accepts a complete theme off the wire, $type tags and all", () => {
    expect(parseTheme(wireTheme)).toEqual(readable);
  });

  it("accepts colours without the optional #rgb $type (the lexicon marks it optional)", () => {
    expect(
      parseTheme({
        accent: rgb(1, 2, 3),
        accentForeground: rgb(4, 5, 6),
        background: rgb(7, 8, 9),
        foreground: rgb(10, 11, 12),
      }),
    ).toEqual({
      accent: rgb(1, 2, 3),
      accentForeground: rgb(4, 5, 6),
      background: rgb(7, 8, 9),
      foreground: rgb(10, 11, 12),
    });
  });

  it("treats an absent theme as no theme", () => {
    expect(parseTheme(undefined)).toBeNull();
    expect(parseTheme(null)).toBeNull();
  });

  it("rejects non-objects rather than coercing them", () => {
    for (const value of ["#ff0000", 42, true, [], () => {}]) {
      expect(parseTheme(value)).toBeNull();
    }
  });

  it("rejects a PARTIAL theme — three colours is not a palette", () => {
    for (const missing of [
      "accent",
      "accentForeground",
      "background",
      "foreground",
    ] as const) {
      const partial: Record<string, unknown> = { ...wireTheme };
      delete partial[missing];
      expect(parseTheme(partial)).toBeNull();
    }
  });

  it("rejects channels that are out of the lexicon's 0–255 range", () => {
    expect(parseTheme({ ...wireTheme, accent: rgb(256, 0, 0) })).toBeNull();
    expect(parseTheme({ ...wireTheme, accent: rgb(-1, 0, 0) })).toBeNull();
    expect(
      parseTheme({ ...wireTheme, background: rgb(0, 0, 999999) }),
    ).toBeNull();
  });

  it("rejects channels that are not integers", () => {
    expect(parseTheme({ ...wireTheme, foreground: rgb(1.5, 0, 0) })).toBeNull();
    expect(
      parseTheme({ ...wireTheme, foreground: rgb(Number.NaN, 0, 0) }),
    ).toBeNull();
    expect(
      parseTheme({
        ...wireTheme,
        foreground: rgb(Number.POSITIVE_INFINITY, 0, 0),
      }),
    ).toBeNull();
  });

  it("rejects channels that arrived as strings, however plausible", () => {
    expect(
      parseTheme({
        ...wireTheme,
        accent: { r: "255", g: "0", b: "0" },
      }),
    ).toBeNull();
  });

  it("rejects a colour that is a CSS string rather than an rgb object", () => {
    // The shape a hostile record would use to try to reach a CSS value
    // context. It never gets past here, so it never reaches themeStyle.
    expect(
      parseTheme({ ...wireTheme, accent: "red; background: url(evil)" }),
    ).toBeNull();
    expect(parseTheme({ ...wireTheme, accent: null })).toBeNull();
  });

  it("ignores unknown extra fields instead of failing on them", () => {
    // Forward compatibility: another app may add fields to the record.
    expect(parseTheme({ ...wireTheme, somethingNew: "later" })).toEqual(
      readable,
    );
  });
});

describe("hex colours", () => {
  it("round-trips #rrggbb", () => {
    expect(parseHexColor("#c52f0f")).toEqual(rgb(197, 47, 15));
    expect(toHexColor(rgb(197, 47, 15))).toBe("#c52f0f");
    expect(toHexColor(rgb(0, 0, 0))).toBe("#000000");
    expect(toHexColor(rgb(255, 255, 255))).toBe("#ffffff");
  });

  it("accepts uppercase and surrounding whitespace", () => {
    expect(parseHexColor("  #C52F0F ")).toEqual(rgb(197, 47, 15));
  });

  it("rejects every other text form", () => {
    for (const value of [
      "#fff",
      "c52f0f",
      "#c52f0",
      "#c52f0ff",
      "rgb(1,2,3)",
      "red",
      "#12345g",
      "",
      undefined,
      null,
      123,
    ]) {
      expect(parseHexColor(value)).toBeNull();
    }
  });

  it("clamps out-of-range channels rather than emitting broken hex", () => {
    expect(toHexColor(rgb(-5, 300, 12.6))).toBe("#00ff0d");
  });

  it("ships defaults that are valid hex and match the app's own palette", () => {
    for (const value of Object.values(DEFAULT_THEME_HEX)) {
      expect(parseHexColor(value)).not.toBeNull();
    }
    // Converted from the styles.css @theme tokens: paper, ink, spot.
    expect(DEFAULT_THEME_HEX.background).toBe("#ffffff");
    expect(DEFAULT_THEME_HEX.foreground).toBe("#161616");
    expect(DEFAULT_THEME_HEX.accent).toBe("#c52f0f");
  });

  it("clears the AA bar with its own defaults", () => {
    const theme = parseThemeForm((field) => DEFAULT_THEME_HEX[field]);
    expect(theme).not.toBeNull();
    expect(theme && themeWarnings(theme)).toEqual([]);
  });
});

describe("parseThemeForm — the write door", () => {
  it("builds a theme from four valid hexes", () => {
    const fields: Record<string, string> = {
      accent: "#c52f0f",
      accentForeground: "#ffffff",
      background: "#ffffff",
      foreground: "#161616",
    };
    expect(parseThemeForm((field) => fields[field])).toEqual(readable);
  });

  it("refuses the whole submit when any one field is malformed or missing", () => {
    const fields: Record<string, string> = {
      accent: "#c52f0f",
      accentForeground: "#ffffff",
      background: "#ffffff",
      foreground: "#161616",
    };
    for (const field of Object.keys(fields)) {
      const broken = { ...fields, [field]: "chartreuse" };
      expect(parseThemeForm((f) => broken[f])).toBeNull();
      const absent = { ...fields };
      delete absent[field];
      expect(parseThemeForm((f) => absent[f])).toBeNull();
    }
  });
});

describe("themeRecord — the value embedded in publication.basicTheme", () => {
  it("names itself and every colour, so other apps can dispatch on $type", () => {
    expect(themeRecord(readable)).toEqual(wireTheme);
  });

  it("round-trips through parseTheme unchanged", () => {
    expect(parseTheme(themeRecord(readable))).toEqual(readable);
  });
});

describe("themeStyle — tokens, never new colour", () => {
  it("returns nothing at all for an absent theme, so the page keeps the defaults", () => {
    expect(themeStyle(null)).toBeUndefined();
    expect(themeStyle(undefined)).toBeUndefined();
  });

  it("sets the same custom properties the reading surfaces already consume", () => {
    const style = themeStyle(readable) as Record<string, string>;
    expect(style["--color-paper"]).toBe("rgb(255 255 255)");
    expect(style["--color-ink"]).toBe("rgb(22 22 22)");
    expect(style["--color-spot"]).toBe("rgb(197 47 15)");
    expect(style["--color-spot-foreground"]).toBe("rgb(255 255 255)");
  });

  it("derives the secondary text and hairline tones from the two the writer chose", () => {
    const style = themeStyle(readable) as Record<string, string>;
    expect(style["--color-ink-soft"]).toBe(
      "color-mix(in oklab, var(--color-ink) 75%, var(--color-paper))",
    );
    expect(style["--color-rule"]).toBe(
      "color-mix(in oklab, var(--color-ink) 20%, var(--color-paper))",
    );
  });

  it("emits only numeric rgb(), so nothing can escape the CSS value context", () => {
    const style = themeStyle(readable) as Record<string, string>;
    for (const [property, value] of Object.entries(style)) {
      if (property === "--color-ink-soft" || property === "--color-rule") {
        // The two derived tokens are static strings this module authored.
        expect(value).toMatch(
          /^color-mix\(in oklab, var\(--color-[a-z]+\) \d+%, var\(--color-[a-z]+\)\)$/,
        );
        continue;
      }
      expect(value).toMatch(/^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/);
    }
  });
});

describe("contrastRatio — WCAG 2.x", () => {
  it("is 21:1 for black on white, both ways round", () => {
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb(255, 255, 255), rgb(0, 0, 0))).toBeCloseTo(21, 5);
  });

  it("is 1:1 for a colour against itself", () => {
    expect(contrastRatio(rgb(120, 30, 200), rgb(120, 30, 200))).toBeCloseTo(
      1,
      5,
    );
  });

  it("matches the published ratio for a known pair", () => {
    // #767676 on white is the canonical "just passes AA" grey, 4.54:1.
    expect(contrastRatio(rgb(118, 118, 118), rgb(255, 255, 255))).toBeCloseTo(
      4.54,
      2,
    );
  });

  it("formats to one decimal", () => {
    expect(formatRatio(4.5)).toBe("4.5:1");
    expect(formatRatio(2.34)).toBe("2.3:1");
    expect(formatRatio(21)).toBe("21:1");
  });
});

describe("themeWarnings — warn, never block", () => {
  it("says nothing about a readable palette", () => {
    expect(themeWarnings(readable)).toEqual([]);
  });

  it("flags body text that fails AA against its background", () => {
    const washedOut: BasicTheme = {
      ...readable,
      foreground: rgb(200, 200, 200),
    };
    const warnings = themeWarnings(washedOut);
    expect(warnings.map((w) => w.id)).toEqual(["body"]);
    expect(warnings[0].ratio).toBeLessThan(AA_CONTRAST);
    expect(warnings[0].message).toContain("4.5:1");
  });

  it("flags button text that fails AA against the accent", () => {
    const invisibleLabel: BasicTheme = {
      ...readable,
      accent: rgb(255, 214, 0),
      accentForeground: rgb(255, 255, 255),
    };
    const warnings = themeWarnings(invisibleLabel);
    expect(warnings.map((w) => w.id)).toEqual(["button"]);
  });

  it("flags both pairs when both fail, and reports each ratio", () => {
    const unreadable: BasicTheme = {
      background: rgb(240, 240, 240),
      foreground: rgb(220, 220, 220),
      accent: rgb(250, 250, 250),
      accentForeground: rgb(255, 255, 255),
    };
    const warnings = themeWarnings(unreadable);
    expect(warnings.map((w) => w.id)).toEqual(["body", "button"]);
    for (const warning of warnings) {
      expect(warning.ratio).toBeLessThan(AA_CONTRAST);
      expect(warning.message).toContain(formatRatio(warning.ratio));
    }
  });

  it("does not warn about a pair sitting exactly on the AA line", () => {
    // #767676 on white is 4.54:1 — over the bar, so it passes silently.
    const onTheLine: BasicTheme = {
      ...readable,
      foreground: rgb(118, 118, 118),
    };
    expect(themeWarnings(onTheLine)).toEqual([]);
  });

  it("warns rather than refusing — a warning is data, not an error", () => {
    // The point of the whole design: an ugly theme still produces a theme.
    const ugly: BasicTheme = {
      background: rgb(255, 0, 255),
      foreground: rgb(255, 255, 0),
      accent: rgb(0, 255, 0),
      accentForeground: rgb(0, 255, 255),
    };
    expect(themeWarnings(ugly).length).toBeGreaterThan(0);
    expect(themeStyle(ugly)).toBeDefined();
    expect(parseTheme(themeRecord(ugly))).toEqual(ugly);
  });
});
