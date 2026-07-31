/**
 * Writer theming — `site.standard.theme.basic`.
 *
 * THE POINT OF DOING IT THIS WAY. A theme here is not a Goldroad setting in
 * our database. It is a record shape in a lexicon Goldroad shares with
 * Leaflet, pckt and Offprint, stored in the WRITER'S repository as part of
 * their `site.standard.publication`. It travels with them if they leave, and
 * any other reader of the same lexicon can honour it. That is why there is no
 * `themes` table anywhere in this codebase and never should be.
 *
 * HOW THE LEXICON LINKS IT — read before changing anything here.
 * `site.standard.publication` declares `basicTheme` as a ref to
 * `site.standard.theme.basic`'s main record type, which in atproto means the
 * theme object is EMBEDDED in the publication record, `$type` and all. It is
 * NOT a strongRef, and there is no URI pointing at a separate record. See
 * `@atcute/standard-site/dist/lexicons/types/site/standard/publication.d.ts`:
 *
 *     readonly basicTheme: v.OptionalSchema<SiteStandardThemeBasic.mainSchema>
 *
 * So one publication write carries the theme. Writing a free-standing
 * `site.standard.theme.basic` record alongside it would leave an orphan in the
 * writer's repo that nothing references and no app reads — litter in someone
 * else's data. We embed, because that is what the lexicon says.
 *
 * EVERY COLOUR IN HERE IS UNTRUSTED. It comes from a writer, and on reading
 * surfaces it comes from a stranger's PDS by way of whatever app they use.
 * `parseTheme` is the only door: it admits four complete colours of integers
 * in 0–255 and rejects everything else as absent. Nothing downstream ever sees
 * a string that came off the network, so nothing can escape a CSS value
 * context — `themeStyle` builds `rgb(r g b)` out of numbers it validated
 * itself.
 */
import type * as SiteStandardThemeBasic from "@atcute/standard-site/types/theme/basic";

/** One colour: `site.standard.theme.color#rgb`, three integers in 0–255. */
export type Rgb = { r: number; g: number; b: number };

/** A complete, validated theme. All four colours — the lexicon requires them
 * all, so a partial theme is not a theme (see `parseTheme`). */
export type BasicTheme = {
  /** Links and button backgrounds. */
  accent: Rgb;
  /** Button text — the readable pair to `accent`. */
  accentForeground: Rgb;
  /** Content background. */
  background: Rgb;
  /** Content text. */
  foreground: Rgb;
};

/** The four fields, in the order the editor shows them. */
export const THEME_FIELDS = [
  "background",
  "foreground",
  "accent",
  "accentForeground",
] as const satisfies ReadonlyArray<keyof BasicTheme>;

export type ThemeField = (typeof THEME_FIELDS)[number];

/**
 * Goldroad's own palette as hex — the values the colour inputs start from when
 * a writer has never set a theme, so "unset" and "the defaults" look the same.
 * Converted from the `@theme` tokens in styles.css (paper `oklch(1 0 0)`, ink
 * `oklch(0.2 0 0)`, spot `oklch(0.54 0.19 33)`); accentForeground is paper,
 * which is what `bg-spot text-paper` already pairs everywhere in the app.
 * If those tokens ever move, these move with them.
 */
export const DEFAULT_THEME_HEX: Record<ThemeField, string> = {
  background: "#ffffff",
  foreground: "#161616",
  accent: "#c52f0f",
  accentForeground: "#ffffff",
};

/** One ready-made palette a writer can start from. */
export type StarterPalette = {
  /** Stable id — the radio's value and what tests key on. Not stored anywhere
   * and never written to a record, so it is safe to rename an id; the colours
   * are the payload. */
  id: string;
  /** What a writer reads. Short enough to sit under a swatch. */
  name: string;
  /** The four fields, as the hexes the colour inputs take. */
  hex: Record<ThemeField, string>;
};

/**
 * Starter palettes — the answer to "make it yours" for a writer who has no
 * brand and does not want to acquire one this afternoon.
 *
 * WHY THESE EXIST. Four colour pickers opening on Goldroad's palette is a
 * design project with no starting point, and most writers will bounce off it
 * and keep our colours — which is the opposite of the point. A row of complete
 * palettes turns four decisions into one, and the four inputs below stay live
 * afterwards, so this is a starting point rather than a mode.
 *
 * TWO RULES HOLD FOR EVERY ENTRY HERE, and a test enforces both.
 *
 * 1. EVERY PALETTE PASSES WCAG AA ON BOTH PAIRS — body text on background, and
 *    button text on accent. We warn writers about unreadable colour; shipping a
 *    one-click palette that trips our own warning would be indefensible. The
 *    margins below are deliberately generous rather than sitting on 4.5:1, so a
 *    writer nudging one colour afterwards does not immediately fall through the
 *    floor. Ratios are stated per palette; they were measured with
 *    `contrastRatio`, not estimated.
 * 2. NONE OF THEM IS GOLDROAD'S OWN PALETTE. `DEFAULT_THEME_HEX` is what the
 *    page already looks like — offering it back as a choice would be offering a
 *    writer the thing they came here to change. "Use the defaults" is the way
 *    back, and it removes the theme rather than storing ours.
 *
 * The range matters as much as the count. Eight variations of grey is not a
 * choice a writer can see, so the set spans warm and cool paper, two dark
 * editions, an earth tone, a maximum-contrast mono, and two that commit to a
 * colour — which is the whole spread a writer is likely to recognise
 * themselves in.
 */
export const STARTER_PALETTES: readonly StarterPalette[] = [
  {
    id: "warm-cream",
    name: "Warm cream",
    // Editorial cream with a chestnut accent. Body 15.1:1, button 7.4:1.
    hex: {
      background: "#fbf6ec",
      foreground: "#23201b",
      accent: "#7a4419",
      accentForeground: "#fdf7ef",
    },
  },
  {
    id: "cool-paper",
    name: "Cool paper",
    // Grey-blue stock, deep teal accent. Body 14.6:1, button 7.3:1.
    hex: {
      background: "#eef2f6",
      foreground: "#16202b",
      accent: "#0f5f70",
      accentForeground: "#ffffff",
    },
  },
  {
    id: "ink-on-white",
    name: "Ink on white",
    // The classic: near-black on white, links in a plain blue that reads as a
    // link to everyone who has ever used the web. Body 17.4:1, button 7.8:1.
    hex: {
      background: "#ffffff",
      foreground: "#1a1a1a",
      accent: "#0b4fa8",
      accentForeground: "#ffffff",
    },
  },
  {
    id: "deep-night",
    name: "Deep night",
    // Dark edition. The accent RISES in lightness, because a dark background
    // swallows a pigment's depth — the same reasoning as our own black-stock
    // edition in styles.css. Body 15.3:1, button 9.1:1.
    hex: {
      background: "#12141a",
      foreground: "#e8eaf0",
      accent: "#8fb3ff",
      accentForeground: "#0e1016",
    },
  },
  {
    id: "muted-earth",
    name: "Muted earth",
    // Oatmeal paper, moss accent. Body 12.4:1, button 6.3:1.
    hex: {
      background: "#f3eee4",
      foreground: "#2e2a22",
      accent: "#4f6146",
      accentForeground: "#f6f8f3",
    },
  },
  {
    id: "high-contrast",
    name: "High contrast",
    // Pure black on pure white, both pairs at 21:1 — the maximum available.
    // Here for the writers who need it and know they need it.
    hex: {
      background: "#ffffff",
      foreground: "#000000",
      accent: "#000000",
      accentForeground: "#ffffff",
    },
  },
  {
    id: "plum",
    name: "Plum",
    // Colour with conviction, on a barely-tinted page. Body 15.1:1, button 9:1.
    hex: {
      background: "#faf5fb",
      foreground: "#2a1b2e",
      accent: "#6d2f7a",
      accentForeground: "#ffffff",
    },
  },
  {
    id: "deep-teal",
    name: "Deep teal",
    // The other confident one, and the second dark edition: teal stock with a
    // warm gold accent carrying dark labels. Body 12.7:1, button 11.3:1.
    hex: {
      background: "#062b33",
      foreground: "#dff0f0",
      accent: "#ffd166",
      accentForeground: "#10241f",
    },
  },
];

const HEX_RE = /^#([0-9a-f]{6})$/i;

/** `#rrggbb` → rgb, or null. The only accepted text form: `<input
 * type="color">` always produces it, and a stricter door means less to guard
 * downstream. */
export function parseHexColor(value: unknown): Rgb | null {
  if (typeof value !== "string") return null;
  const match = HEX_RE.exec(value.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHexColor({ r, g, b }: Rgb): string {
  const hex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Which starter palette the editor's four fields currently spell, if any.
 *
 * Selection is DERIVED rather than remembered, and that is the whole trick: a
 * writer who picks "Plum" and then darkens the accent is no longer on Plum, and
 * nothing has to notice the edit and clear a flag. It also means a writer who
 * happens to arrive at a palette's exact colours by hand gets told so.
 * Case-insensitive because a hex is a value, not a spelling.
 */
export function matchStarterPalette(
  hex: Record<ThemeField, string>,
): StarterPalette | null {
  const same = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase();
  return (
    STARTER_PALETTES.find((palette) =>
      THEME_FIELDS.every((field) => same(hex[field] ?? "", palette.hex[field])),
    ) ?? null
  );
}

/** One colour off the network. Integers only, in range — the lexicon's own
 * constraint (`@minimum 0`, `@maximum 255`), enforced rather than assumed. */
function parseRgb(value: unknown): Rgb | null {
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, number> = {};
  for (const key of ["r", "g", "b"] as const) {
    const channel = (value as Record<string, unknown>)[key];
    if (typeof channel !== "number" || !Number.isInteger(channel)) return null;
    if (channel < 0 || channel > 255) return null;
    out[key] = channel;
  }
  return { r: out.r, g: out.g, b: out.b };
}

/**
 * The read door. Takes `publication.basicTheme` exactly as it came off a PDS —
 * any author's, not only ours — and returns a theme or null.
 *
 * Null means "no theme", and every caller treats it as the default palette.
 * That covers absent, a non-object, three colours instead of four, a channel
 * that is a string or a float or 300, and anything else a hostile or buggy
 * writer could put there. A theme is never partially applied: half a palette
 * is how you get black text on a black page.
 */
export function parseTheme(value: unknown): BasicTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const accent = parseRgb(source.accent);
  const accentForeground = parseRgb(source.accentForeground);
  const background = parseRgb(source.background);
  const foreground = parseRgb(source.foreground);
  if (!accent || !accentForeground || !background || !foreground) return null;
  return { accent, accentForeground, background, foreground };
}

/** The four form fields → a theme, or null if any one of them is malformed.
 * Same all-or-nothing rule as `parseTheme`, applied at the write door. */
export function parseThemeForm(
  read: (field: ThemeField) => unknown,
): BasicTheme | null {
  const accent = parseHexColor(read("accent"));
  const accentForeground = parseHexColor(read("accentForeground"));
  const background = parseHexColor(read("background"));
  const foreground = parseHexColor(read("foreground"));
  if (!accent || !accentForeground || !background || !foreground) return null;
  return { accent, accentForeground, background, foreground };
}

/**
 * The embedded record value for `publication.basicTheme`. `$type` is written
 * on the theme and on each colour: `accent` and friends are union-typed fields
 * in the lexicon, and a union member that names itself is the shape every
 * other implementation can dispatch on without guessing.
 */
export function themeRecord(theme: BasicTheme): SiteStandardThemeBasic.Main {
  const colour = ({ r, g, b }: Rgb) =>
    ({ $type: "site.standard.theme.color#rgb", r, g, b }) as const;
  return {
    $type: "site.standard.theme.basic",
    accent: colour(theme.accent),
    accentForeground: colour(theme.accentForeground),
    background: colour(theme.background),
    foreground: colour(theme.foreground),
  };
}

/** `rgb(r g b)` from integers this module validated. Clamped again here so the
 * function is safe on its own terms rather than on its callers'. */
function rgbCss({ r, g, b }: Rgb): string {
  const channel = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)})`;
}

/**
 * A theme as the page's design tokens — the same `--color-paper` /
 * `--color-ink` / `--color-spot` the reading surfaces already consume, so
 * every existing utility class (`bg-paper`, `text-ink-soft`, `border-rule`,
 * `bg-ink/5`) retints without a single component changing. No parallel system,
 * no `dark:` variants, no hard-coded colour.
 *
 * `ink-soft` and `rule` are DERIVED rather than asked for: the lexicon has
 * four colours and this palette has six, and a writer choosing a secondary
 * text grey is the design tool this feature is deliberately not. They mix in
 * oklab, which keeps a mid-tone off a dark background from going muddy the way
 * an sRGB blend does. Static strings referencing the two variables set above —
 * no untrusted value is interpolated into them.
 */
export function themeStyle(
  theme: BasicTheme | null | undefined,
): React.CSSProperties | undefined {
  if (!theme) return undefined;
  return {
    "--color-paper": rgbCss(theme.background),
    "--color-ink": rgbCss(theme.foreground),
    "--color-spot": rgbCss(theme.accent),
    "--color-spot-foreground": rgbCss(theme.accentForeground),
    "--color-ink-soft":
      "color-mix(in oklab, var(--color-ink) 75%, var(--color-paper))",
    "--color-rule":
      "color-mix(in oklab, var(--color-ink) 20%, var(--color-paper))",
  } as React.CSSProperties;
}

/** WCAG relative luminance (WCAG 2.x, sRGB). */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG AA for normal-size text. Both pairs we check are body-size text. */
export const AA_CONTRAST = 4.5;

export type ThemeWarning = {
  /** Stable id for tests and keys. */
  id: "body" | "button";
  /** Measured ratio, e.g. 2.3 for "2.3:1". */
  ratio: number;
  message: string;
};

/** One decimal, so "4.5:1" reads as the threshold it is. */
export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 10) / 10}:1`;
}

/**
 * Unreadable colour pairs, as warnings — never as errors.
 *
 * A writer is allowed to make an ugly page. They are not allowed to make an
 * unreadable one WITHOUT BEING TOLD, which is a different rule: we say what is
 * wrong and what the numbers are, and then we save whatever they chose. The
 * page is theirs.
 *
 * Two pairs, both the lexicon's own: body text on the content background, and
 * button text on the accent.
 */
export function themeWarnings(theme: BasicTheme): ThemeWarning[] {
  const warnings: ThemeWarning[] = [];
  const body = contrastRatio(theme.foreground, theme.background);
  if (body < AA_CONTRAST) {
    warnings.push({
      id: "body",
      ratio: body,
      message: `Your text and background are ${formatRatio(body)} apart — under the ${formatRatio(AA_CONTRAST)} readable-contrast standard. Some readers won't be able to read your posts.`,
    });
  }
  const button = contrastRatio(theme.accentForeground, theme.accent);
  if (button < AA_CONTRAST) {
    warnings.push({
      id: "button",
      ratio: button,
      message: `Your button text and accent are ${formatRatio(button)} apart — under the ${formatRatio(AA_CONTRAST)} readable-contrast standard. Labels on accent-coloured elements will be hard to read.`,
    });
  }
  return warnings;
}
