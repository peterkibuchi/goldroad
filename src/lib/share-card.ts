/**
 * The post's share card: the picture a link preview shows, drawn in the
 * writer's browser when they publish or save an edit.
 *
 * The card is the post page's own header cut to 1200×630: the publication
 * name as a small tracked label, the title in the display face, the writer's
 * name under a rule, and the theme's accent spent once, as a stripe along the
 * top edge. Text sits on the theme's background and foreground, the pair the
 * theme editor checks for contrast, so every theme a writer can save gives a
 * readable card. Nothing reads the accent's own foreground.
 *
 * WHY THE BROWSER DRAWS IT. workerd has no canvas, and drawing text in a
 * Worker means shipping a font rasteriser into a 10 ms CPU budget. The writer's
 * browser already has the fonts loaded and a canvas for free. The PNG then
 * rides the publish form to `/api/publish`, which stores it in the writer's
 * own repo (see `goldroadShareCard` in ~/lib/publish).
 *
 * Imported by the write page only. The reader pages never draw a card; they
 * name the stored one in their head.
 */
import { SHARE_CARD_MIME } from "~/lib/publish";
import {
  type BasicTheme,
  DEFAULT_THEME_HEX,
  parseHexColor,
  type Rgb,
} from "~/lib/theme";

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

export type ShareCardInput = {
  title: string;
  /** The publication's name (the writer's handle when it has none yet). */
  label: string;
  /** The byline, as the post page prints it. */
  name: string;
  /** The publication's theme; null draws the unthemed page's own colours. */
  theme: BasicTheme | null;
};

// ---- Layout, in card pixels (comp A, "Header echo") ----------------------

const PAD_X = 72;
const PAD_TOP = 82;
const PAD_BOTTOM = 64;
const COLUMN = SHARE_CARD_WIDTH - PAD_X * 2;
const STRIPE = 12;

const LABEL = { size: 26, lineHeight: 1.2, tracking: 0.14 };
const NAME = { size: 32, lineHeight: 1.25 };
/** Rule above the name: its thickness and the gaps on either side. */
const RULE = { thickness: 2, above: 36, below: 22 };

/**
 * The title steps down until it fits: the first size that wraps to `lines`
 * or fewer wins. The last step clamps to its lines and ends in an ellipsis,
 * which only a title near the 1,000-character cap ever reaches.
 */
export const TITLE_STEPS = [
  { size: 86, lineHeight: 1.03, lines: 3 },
  { size: 72, lineHeight: 1.05, lines: 3 },
  { size: 60, lineHeight: 1.07, lines: 4 },
  { size: 50, lineHeight: 1.1, lines: 4 },
] as const;
const TITLE_TRACKING = -0.022;

/** The display face goldroad ships (@fontsource-variable/libre-franklin, the
 * `--font-display` stack in styles.css). One variable file covers every
 * weight the card uses. */
const FACE = '"Libre Franklin Variable"';
const STACK = `${FACE}, "Libre Franklin Fallback", system-ui, sans-serif`;
const font = (weight: number, size: number) => `${weight} ${size}px ${STACK}`;

const ELLIPSIS = "…";

// ---- Colour ---------------------------------------------------------------

/** `color-mix(in oklab, a <weight>, b)`, the mix the reading page derives its
 * rule colour with (`themeStyle` in ~/lib/theme), done in numbers because a
 * canvas fill can't be trusted to parse color-mix everywhere. */
export function mixOklab(a: Rgb, b: Rgb, weight: number): Rgb {
  const la = toOklab(a);
  const lb = toOklab(b);
  return fromOklab(la.map((v, i) => v * weight + lb[i] * (1 - weight)));
}

function toOklab({ r, g, b }: Rgb): number[] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: number[]): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const gamma = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const css = ({ r, g, b }: Rgb) => `rgb(${r} ${g} ${b})`;

/** The card's four paints. An unthemed writer gets the unthemed page's own
 * palette, vermillion stripe included. */
export function shareCardColors(theme: BasicTheme | null) {
  const hex = (field: keyof typeof DEFAULT_THEME_HEX) =>
    parseHexColor(DEFAULT_THEME_HEX[field]) as Rgb;
  const background = theme?.background ?? hex("background");
  const foreground = theme?.foreground ?? hex("foreground");
  const accent = theme?.accent ?? hex("accent");
  return {
    background: css(background),
    foreground: css(foreground),
    accent: css(accent),
    rule: css(mixOklab(foreground, background, 0.2)),
  };
}

// ---- Text fitting (pure: measurement is injected) ------------------------

/** Width of `text` set at `size` px. */
export type Measure = (text: string, size: number) => number;

/** Grapheme clusters, so a break never splits an emoji or an accent. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl)
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  return Array.from(text);
}

/**
 * Greedy word wrap into `width`, measured per word. A word wider than the
 * column breaks between graphemes, as CSS `overflow-wrap: anywhere` does,
 * which is also how a title in a script without spaces wraps at all.
 */
export function wrapWords(
  text: string,
  size: number,
  width: number,
  measure: Measure,
): string[] {
  const lines: string[] = [];
  let line = "";
  const place = (word: string) => {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size) <= width) {
      line = candidate;
      return;
    }
    if (line) lines.push(line);
    line = "";
    if (measure(word, size) <= width) {
      line = word;
      return;
    }
    for (const g of graphemes(word)) {
      if (line && measure(line + g, size) > width) {
        lines.push(line);
        line = "";
      }
      line += g;
    }
  };
  for (const word of text.split(/\s+/).filter(Boolean)) place(word);
  if (line) lines.push(line);
  return lines;
}

/** `text` cut to fit `width` with an ellipsis, at a word when one fits, else
 * between graphemes. Text that already fits comes back unchanged unless
 * `force` says more followed it. */
export function ellipsize(
  text: string,
  size: number,
  width: number,
  measure: Measure,
  force = false,
): string {
  if (!force && measure(text, size) <= width) return text;
  let kept = text.trimEnd();
  while (kept && measure(kept + ELLIPSIS, size) > width) {
    const cut = kept.lastIndexOf(" ");
    kept =
      cut > 0 && measure(kept.slice(0, cut) + ELLIPSIS, size) <= width
        ? kept.slice(0, cut)
        : graphemes(kept).slice(0, -1).join("");
    kept = kept.trimEnd();
  }
  return kept + ELLIPSIS;
}

export type FittedTitle = {
  size: number;
  lineHeight: number;
  lines: string[];
};

/** The title at the first step it fits, clamped with an ellipsis at the last. */
export function fitTitle(
  title: string,
  measure: Measure,
  width = COLUMN,
): FittedTitle {
  for (const step of TITLE_STEPS) {
    const lines = wrapWords(title, step.size, width, measure);
    if (lines.length <= step.lines)
      return { size: step.size, lineHeight: step.lineHeight, lines };
  }
  const last = TITLE_STEPS[TITLE_STEPS.length - 1];
  const lines = wrapWords(title, last.size, width, measure).slice(
    0,
    last.lines,
  );
  lines[last.lines - 1] = ellipsize(
    lines[last.lines - 1],
    last.size,
    width,
    measure,
    true,
  );
  return { size: last.size, lineHeight: last.lineHeight, lines };
}

// ---- Drawing --------------------------------------------------------------

/**
 * Draws the card onto `canvas`. Synchronous: call `loadShareCardFonts` first,
 * or the face falls back to whatever the browser has.
 */
export function renderShareCard(
  canvas: HTMLCanvasElement,
  input: ShareCardInput,
): boolean {
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const colors = shareCardColors(input.theme);
  // Canvas tracking where the engine has it (every current one), so shaping
  // and bidi stay the browser's; per-glyph placement where it doesn't.
  const tracks =
    typeof (ctx as { letterSpacing?: unknown }).letterSpacing === "string";

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, STRIPE);

  ctx.fillStyle = colors.foreground;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  /** Sets the font and tracking for one block of text, and returns a
   * measure for it. `tracking` is in em, as the CSS it stands in for. */
  const use = (weight: number, tracking: number): Measure => {
    return (text, size) => {
      setFont(weight, size, tracking);
      return tracks || tracking === 0
        ? ctx.measureText(text).width
        : perGlyphWidth(text, size * tracking);
    };
  };
  const setFont = (weight: number, size: number, tracking: number) => {
    ctx.font = font(weight, size);
    if (tracks) ctx.letterSpacing = `${size * tracking}px`;
  };
  const perGlyphWidth = (text: string, spacing: number) =>
    graphemes(text).reduce(
      (sum, g) => sum + ctx.measureText(g).width + spacing,
      0,
    );
  /** The baseline CSS would give a line box `lineHeight` tall at `top`: the
   * font's ascent plus half the leading. */
  const baseline = (top: number, size: number, lineHeight: number) => {
    const m = ctx.measureText("Hg");
    const ascent = m.fontBoundingBoxAscent ?? size * 0.97;
    const descent = m.fontBoundingBoxDescent ?? size * 0.25;
    return top + (size * lineHeight - (ascent + descent)) / 2 + ascent;
  };
  const draw = (text: string, y: number, size: number, tracking: number) => {
    if (tracks || tracking === 0) {
      ctx.fillText(text, PAD_X, y);
      return;
    }
    let x = PAD_X;
    for (const g of graphemes(text)) {
      ctx.fillText(g, x, y);
      x += ctx.measureText(g).width + size * tracking;
    }
  };

  // The label: one line at the top, ellipsised at the column.
  const labelMeasure = use(600, LABEL.tracking);
  const label = ellipsize(
    input.label.toUpperCase(),
    LABEL.size,
    COLUMN,
    labelMeasure,
  );
  setFont(600, LABEL.size, LABEL.tracking);
  draw(
    label,
    baseline(PAD_TOP, LABEL.size, LABEL.lineHeight),
    LABEL.size,
    LABEL.tracking,
  );

  // The byline, from the bottom up: the name, then the rule above it.
  const nameTop = SHARE_CARD_HEIGHT - PAD_BOTTOM - NAME.size * NAME.lineHeight;
  const ruleTop = nameTop - RULE.below - RULE.thickness;
  const nameMeasure = use(600, 0);
  const name = ellipsize(input.name, NAME.size, COLUMN, nameMeasure);
  setFont(600, NAME.size, 0);
  draw(name, baseline(nameTop, NAME.size, NAME.lineHeight), NAME.size, 0);
  ctx.fillStyle = colors.rule;
  ctx.fillRect(PAD_X, ruleTop, COLUMN, RULE.thickness);

  // The title sits on the rule, the way `margin-top: auto` sets it on the page.
  ctx.fillStyle = colors.foreground;
  const titleMeasure = use(800, TITLE_TRACKING);
  const fitted = fitTitle(input.title, titleMeasure);
  const step = fitted.size * fitted.lineHeight;
  const titleTop = ruleTop - RULE.above - step * fitted.lines.length;
  setFont(800, fitted.size, TITLE_TRACKING);
  fitted.lines.forEach((line, i) => {
    draw(
      line,
      baseline(titleTop + step * i, fitted.size, fitted.lineHeight),
      fitted.size,
      TITLE_TRACKING,
    );
  });
  return true;
}

/**
 * Loads the faces the card draws in, for exactly the characters it draws
 * (the font ships in unicode-range subsets). Resolves false when they don't
 * arrive in time: a card set in a fallback face is not the card, and the
 * post's link preview is better served by its cover until the next save.
 */
export async function loadShareCardFonts(
  input: ShareCardInput,
  timeoutMs = 4000,
): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return false;
  const text = `${input.label.toUpperCase()} ${input.title} ${input.name}`;
  const loads = Promise.all([
    document.fonts.load(`800 50px ${FACE}`, text),
    document.fonts.load(`600 26px ${FACE}`, text),
  ]).then(
    (faces) => faces.every((found) => found.length > 0),
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), timeoutMs),
  );
  return Promise.race([loads, timeout]);
}

/** The card as a PNG, or null when this browser can't draw it. Never throws:
 * a publish must not fail over its preview image. */
export async function drawShareCard(
  input: ShareCardInput,
): Promise<Blob | null> {
  try {
    if (!(await loadShareCardFonts(input))) return null;
    const canvas = document.createElement("canvas");
    if (!renderShareCard(canvas, input)) return null;
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, SHARE_CARD_MIME),
    );
  } catch (err) {
    console.warn("share card draw failed", err);
    return null;
  }
}

// ---- Identity -------------------------------------------------------------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The CID a PDS will give these bytes as a blob: CIDv1, raw codec, sha2-256,
 * base32. Lets an edit tell, before uploading anything, that the card it just
 * drew is the one the record already holds.
 */
export async function blobCid(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const cid = new Uint8Array(4 + digest.length);
  cid.set([0x01, 0x55, 0x12, 0x20]);
  cid.set(digest, 4);
  let out = "b";
  let buffer = 0;
  let bits = 0;
  for (const byte of cid) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}
