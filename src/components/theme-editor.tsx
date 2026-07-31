import { useState } from "react";

import {
  type BasicTheme,
  DEFAULT_THEME_HEX,
  parseThemeForm,
  THEME_FIELDS,
  type ThemeField,
  themeStyle,
  themeWarnings,
  toHexColor,
} from "~/lib/theme";

/**
 * The theme editor — four colours, a preview of what a reader will see, and a
 * way back to the defaults.
 *
 * Deliberately not a design tool. There is no palette generator, no shade
 * ramp, no font picker and no live CSS: the lexicon has four colours, so this
 * has four colours. Everything else a page needs (secondary text, hairlines)
 * is derived from them, which is also what stops a writer from having to make
 * six decisions to change one.
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
}: {
  /** Shown in the preview's masthead slot so it reads as the writer's page. */
  publicationName: string;
  /** The theme in the writer's publication record, or null if it has none. */
  theme: BasicTheme | null;
}) {
  const [hex, setHex] = useState(() => initialHex(theme));
  // Every hex in state came from the defaults or from a colour input, both of
  // which can only produce `#rrggbb` — so this never returns null in practice.
  // The fallback keeps the component honest rather than asserting.
  const previewTheme = parseThemeForm((field) => hex[field]);
  const warnings = previewTheme ? themeWarnings(previewTheme) : [];

  return (
    // Margins per band rather than a flex `gap`: the live region below has to
    // stay in the DOM at all times for a screen reader to announce into it,
    // and a gap would reserve a band of dead space around it while it is
    // empty. `:not(:empty)` gives it room only once it has something to say.
    <form action="/api/publish" className="flex flex-col" method="post">
      <input name="intent" type="hidden" value="theme" />
      <div className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
        <fieldset className="flex flex-col gap-4">
          <legend className="sr-only">Colours</legend>
          {THEME_FIELDS.map((field) => (
            <div className="flex items-center gap-3" key={field}>
              {/* The native picker is the whole control: it carries its own
                  hex entry and eyedropper on every platform we support, so
                  there is no second field to keep in sync. */}
              <input
                aria-describedby={`${field}-help`}
                className="h-10 w-10 shrink-0 cursor-pointer border border-rule bg-paper p-1"
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
        <button
          className="min-h-11 cursor-pointer bg-spot px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
          type="submit"
        >
          Save colours
        </button>
        {/* The escape. Submits as its own field, and the handler removes
            `basicTheme` rather than writing our palette into the writer's
            repo — reverting should leave no trace that a theme was ever set. */}
        <button
          className="-my-2 inline-flex min-h-11 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
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
