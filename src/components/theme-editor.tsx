import { useState } from "react";

import {
  type BasicTheme,
  DEFAULT_THEME_HEX,
  matchStarterPalette,
  parseThemeForm,
  STARTER_PALETTES,
  type StarterPalette,
  THEME_FIELDS,
  type ThemeField,
  themeStyle,
  themeWarnings,
  toHexColor,
} from "~/lib/theme";
import { cn } from "~/lib/utils";

/**
 * The theme editor — a shelf of starter palettes, four colours, a preview of
 * what a reader will see, and a way back to the defaults.
 *
 * Deliberately not a design tool. There is no palette generator, no shade
 * ramp, no font picker and no live CSS: the lexicon has four colours, so this
 * has four colours. Everything else a page needs (secondary text, hairlines)
 * is derived from them, which is also what stops a writer from having to make
 * six decisions to change one.
 *
 * The starter palettes are the same argument applied one level up. A writer
 * with no existing brand wants their page to look like theirs without it
 * becoming an afternoon's work, and four pickers opening on OUR colours is a
 * blank canvas with a worked example already on it. A fixed, curated shelf is
 * not a generator: it turns four decisions into one, and the four inputs stay
 * live underneath, so picking one is a starting point rather than a mode.
 *
 * Contrast WARNS and never blocks. Nothing here is disabled, nothing is
 * refused, and "Save colours" stays live no matter what the ratios say — a
 * writer is allowed to make an ugly page. What they are not allowed to do is
 * make an unreadable one without being told, so the numbers are stated plainly
 * and the choice stays theirs.
 *
 * The form posts to /api/publish like every other write in this app; the four
 * `<input type="color">` elements ARE the fields, so what the writer sees is
 * literally what gets submitted.
 */

const LABELS: Record<ThemeField, { name: string; help: string }> = {
  background: { name: "Background", help: "The page your words sit on." },
  foreground: { name: "Text", help: "Your body text and headlines." },
  accent: { name: "Accent", help: "Links, and buttons other apps draw." },
  accentForeground: {
    name: "Text on accent",
    help: "Labels sitting on the accent colour.",
  },
};

/** A theme's hexes, or the defaults — the inputs' starting values. An unset
 * theme and the default palette look identical here on purpose: a writer
 * opening this for the first time sees the page they already have. */
function initialHex(theme: BasicTheme | null): Record<ThemeField, string> {
  if (!theme) return { ...DEFAULT_THEME_HEX };
  return {
    background: toHexColor(theme.background),
    foreground: toHexColor(theme.foreground),
    accent: toHexColor(theme.accent),
    accentForeground: toHexColor(theme.accentForeground),
  };
}

/**
 * A palette as four colours doing their jobs — page, body text, and a label on
 * the accent — at the size of a postage stamp.
 *
 * A name alone tells a writer nothing: "Plum" and "Muted earth" are guesses
 * until you see them. So the specimen is drawn in the palette's OWN colours
 * rather than described in ours, and it shows all four, including the pair
 * inside the little button — the one a writer would otherwise only discover
 * after saving.
 *
 * Inline colour is fine here and nowhere near the `themeStyle` rules: these
 * hexes are compile-time constants from our own module, not a value that came
 * off a stranger's PDS. Marked `aria-hidden` because the label beside it
 * already carries the accessible name — a screen reader gains nothing from
 * three coloured rectangles.
 */
function PaletteSpecimen({ palette }: { palette: StarterPalette }) {
  const { background, foreground, accent, accentForeground } = palette.hex;
  return (
    <span
      aria-hidden="true"
      className="flex h-14 flex-col justify-center gap-1.5 border border-rule px-2"
      style={{ backgroundColor: background }}
    >
      <span
        className="block h-1.5 w-10/12"
        style={{ backgroundColor: foreground }}
      />
      <span
        className="block h-1 w-7/12 opacity-60"
        style={{ backgroundColor: foreground }}
      />
      <span
        className="flex h-3.5 w-8 items-center justify-center"
        style={{ backgroundColor: accent }}
      >
        <span
          className="block h-1 w-4"
          style={{ backgroundColor: accentForeground }}
        />
      </span>
    </span>
  );
}

/**
 * The shelf. One choice among several, so it is a real radio group: native
 * inputs sharing a name, which is what gives a keyboard arrow keys within the
 * group and one tab stop for the whole thing, for free and correctly.
 *
 * The radio is VISIBLE rather than hidden behind a styled swatch. Selection
 * then reads as a filled dot and is announced as "selected" by a screen reader,
 * neither of which depends on seeing a colour — which matters more here than
 * anywhere else in the app, since every other pixel in the control is colour.
 * The cell's border follows along, but it is the second signal, not the only
 * one.
 *
 * Ink and rules, no spot: this section's one accent moment is already spent by
 * "Save colours" below (see DESIGN.md). It also sits beside eight swatches of
 * somebody else's colour, where our vermillion would read as a ninth.
 *
 * The radios post as `palette` and the publish handler never reads it — it
 * takes the four colour fields and `reset`, nothing else. The selection is a
 * shortcut for filling the fields, not a thing we store.
 */
function StarterPalettes({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (palette: StarterPalette) => void;
}) {
  return (
    <fieldset aria-describedby="palettes-help">
      <legend className="font-display text-ink-soft text-xs uppercase tracking-wide">
        Starter palettes
      </legend>
      <p
        className="mt-2 font-display text-ink-soft text-xs leading-relaxed"
        id="palettes-help"
      >
        Pick one to fill the four colours below, then change anything you like.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STARTER_PALETTES.map((palette) => (
          <label
            className={cn(
              "flex cursor-pointer flex-col gap-2 border p-2 transition-colors",
              palette.id === selectedId
                ? "border-ink"
                : "border-rule hover:border-ink",
            )}
            key={palette.id}
          >
            <PaletteSpecimen palette={palette} />
            <span className="flex items-center gap-2">
              <input
                checked={palette.id === selectedId}
                className="size-4 shrink-0 cursor-pointer accent-ink"
                name="palette"
                onChange={() => onSelect(palette)}
                type="radio"
                value={palette.id}
              />
              <span className="min-w-0 font-display text-ink text-xs">
                {palette.name}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * What a reader gets, in miniature — rendered through the SAME `themeStyle`
 * and the same `data-writer-theme` / `gr-prose` hooks the real page uses, so
 * the preview cannot drift from the article. Nothing here is a mock-up of the
 * tokens; it is the tokens.
 */
function ThemePreview({
  theme,
  publicationName,
}: {
  theme: BasicTheme;
  publicationName: string;
}) {
  return (
    <div
      className="border border-rule"
      data-writer-theme=""
      style={themeStyle(theme)}
    >
      <div className="bg-paper px-5 py-6 font-body text-ink">
        <p className="font-display font-semibold text-[0.7rem] text-ink uppercase tracking-[0.14em]">
          {publicationName}
        </p>
        <h3 className="mt-3 text-balance font-semibold text-2xl leading-[1.15]">
          The morning the presses stopped
        </h3>
        <p className="mt-2 font-display text-ink-soft text-xs">
          July 31, 2026 · 4 min read
        </p>
        <div className="gr-prose mt-4 border-rule border-t pt-4 text-[0.95rem] leading-[1.65]">
          <p>
            Body text on your background, at the size a reader gets it. A{" "}
            {/* A real anchor, because the accent reaches links through a CSS
                rule and a <span> would show the writer a colour their readers
                never see. Points at this section's own heading (settings.tsx)
                so clicking it can't cost anyone their unsaved picks. */}
            <a href="#colours-heading">link inside a sentence</a> takes your
            accent, and{" "}
            <span className="bg-spot px-1 text-spot-foreground">
              selected text
            </span>{" "}
            shows the pair behind it.
          </p>
        </div>
      </div>
    </div>
  );
}

export function ThemeEditor({
  publicationName,
  theme,
  disabled = false,
}: {
  /** Shown in the preview's masthead slot so it reads as the writer's page. */
  publicationName: string;
  /** The theme in the writer's publication record, or null if it has none. */
  theme: BasicTheme | null;
  /** Set when the publication couldn't be read. `theme` is then null for want
   * of an answer rather than for want of a theme, so the editor is showing
   * defaults — and saving them would overwrite colours the writer did choose. */
  disabled?: boolean;
}) {
  const [hex, setHex] = useState(() => initialHex(theme));
  // Every hex in state came from the defaults, a starter palette or a colour
  // input, all of which can only produce `#rrggbb` — so this never returns null
  // in practice. The fallback keeps the component honest rather than asserting.
  const previewTheme = parseThemeForm((field) => hex[field]);
  const warnings = previewTheme ? themeWarnings(previewTheme) : [];
  // Read off the colours themselves, so editing any one of them leaves the
  // palette rather than contradicting a remembered selection.
  const selected = matchStarterPalette(hex);

  return (
    // Margins per band rather than a flex `gap`: the live region below has to
    // stay in the DOM at all times for a screen reader to announce into it,
    // and a gap would reserve a band of dead space around it while it is
    // empty. `:not(:empty)` gives it room only once it has something to say.
    <form action="/api/publish" className="flex flex-col" method="post">
      <input name="intent" type="hidden" value="theme" />
      {/* Above the pickers, because it is where a writer starts: one choice
          that fills all four, and then the four are there to adjust. */}
      <div className="mb-8">
        <StarterPalettes
          onSelect={(palette) => setHex({ ...palette.hex })}
          selectedId={selected?.id ?? null}
        />
      </div>
      <div className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
        <fieldset className="flex flex-col gap-4">
          <legend className="sr-only">Colours</legend>
          {THEME_FIELDS.map((field) => (
            <div className="flex items-center gap-3" key={field}>
              {/* The native picker is the whole control: it carries its own
                  hex entry and eyedropper on every platform we support, so
                  there is no second field to keep in sync. Which also makes it
                  the only target — the label beside it opens the picker but is
                  a ~20px run of text, so the swatch itself has to clear 44px. */}
              <input
                aria-describedby={`${field}-help`}
                className="size-11 shrink-0 cursor-pointer border border-rule bg-paper p-1"
                id={field}
                name={field}
                onChange={(event) =>
                  setHex((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
                type="color"
                value={hex[field]}
              />
              <div className="min-w-0">
                <label
                  className="font-bold font-display text-ink text-sm"
                  htmlFor={field}
                >
                  {LABELS[field].name}
                </label>
                <p
                  className="font-display text-ink-soft text-xs leading-relaxed"
                  id={`${field}-help`}
                >
                  {LABELS[field].help}{" "}
                  <span className="uppercase">{hex[field]}</span>
                </p>
              </div>
            </div>
          ))}
        </fieldset>
        <div>
          <p className="mb-2 font-display text-ink-soft text-xs uppercase tracking-wide">
            Preview
          </p>
          {previewTheme && (
            <ThemePreview
              publicationName={publicationName}
              theme={previewTheme}
            />
          )}
        </div>
      </div>

      {/* Advisory, not an error: a polite live region — never role="alert" —
          and the save button below it is never disabled. Always rendered, so
          a warning arrives as new text in a region the reader is already in
          rather than as a region appearing from nowhere.

          Ink, not the accent, and that is the point rather than a preference.
          The accent means two things in this app — the primary action, and an
          error (see Notice) — and this is neither: it is a remark about a
          choice we are about to save anyway. It also sits inches from a
          preview rendering the WRITER'S accent, and two unrelated reds side by
          side read as a rendering fault rather than as two meanings. */}
      <div aria-live="polite" className="[&:not(:empty)]:mt-8">
        {warnings.map((warning) => (
          <p
            className="border border-ink px-4 py-3 font-display text-ink text-sm leading-relaxed [&+&]:mt-3"
            key={warning.id}
          >
            {warning.message}
          </p>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* Ink, not spot — the rail's "New post" already spends /settings' one
            accent moment. It reads doubly wrong here: inches away sits a
            preview painted in the WRITER'S accent, and two unrelated reds side
            by side look like a rendering fault. */}
        <button
          className="min-h-11 cursor-pointer bg-ink px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-spot disabled:cursor-default disabled:opacity-40"
          disabled={disabled}
          type="submit"
        >
          Save colours
        </button>
        {/* The escape. Submits as its own field, and the handler removes
            `basicTheme` rather than writing our palette into the writer's
            repo — reverting should leave no trace that a theme was ever set. */}
        <button
          className="-my-2 inline-flex min-h-11 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink disabled:cursor-default disabled:opacity-40"
          disabled={disabled}
          name="reset"
          type="submit"
          value="1"
        >
          Use the defaults
        </button>
      </div>
    </form>
  );
}
