/**
 * The Appearance control — three-way, writer surfaces only.
 *
 * Deliberately not a two-state toggle. "System" is the honest default and the
 * one most people want; collapsing it into a switch forces a writer to pick a
 * side they never asked to pick, and loses the ability to follow their machine
 * at dusk.
 *
 * The preference lives in localStorage, never a cookie. Reading surfaces are
 * edge-cached and cookie-independent, and a theme cookie would fragment that
 * cache for every visitor — so the flash-of-wrong-edition problem is solved by
 * the blocking bootstrap in `__root`, not by varying the response.
 *
 * This only affects writer surfaces. Marketing stays ink-on-paper permanently,
 * and a publication's own pages belong to its writer through theming rather
 * than to this control — which is why the copy says "your writing surfaces"
 * rather than implying it themes the whole site.
 */
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

export type Appearance = "system" | "light" | "dark";

const STORAGE_KEY = "gr-appearance";

const OPTIONS: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function isAppearance(value: string | null): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

/** Applies a choice to the document, mirroring the pre-paint bootstrap. */
function apply(next: Appearance): void {
  const dark =
    next === "dark" ||
    (next === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}

export function AppearanceControl() {
  // Starts at the honest default rather than reading storage during render:
  // the server has no localStorage, so anything else would mismatch on
  // hydration. The effect below corrects it before a writer can notice.
  const [choice, setChoice] = useState<Appearance>("system");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isAppearance(stored)) setChoice(stored);
  }, []);

  // A writer on "system" should follow their machine as it changes, not just
  // at load. Only while "system" is selected — an explicit choice wins.
  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  function choose(next: Appearance) {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode storage refusal shouldn't break the control; the choice
      // still applies for this session.
    }
    apply(next);
  }

  return (
    <div>
      <fieldset className="flex divide-x divide-ink border border-ink">
        <legend className="sr-only">Appearance</legend>
        {OPTIONS.map((option) => {
          const active = option.value === choice;
          return (
            <button
              aria-pressed={active}
              className={cn(
                "inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center px-4 font-display text-sm transition-colors focus-visible:-outline-offset-2",
                active
                  ? "bg-ink font-bold text-paper"
                  : "text-ink-soft hover:bg-ink/5 hover:text-ink",
              )}
              key={option.value}
              onClick={() => choose(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </fieldset>
      <p className="mt-2 font-display text-ink-soft text-sm">
        Applies to your writing surfaces on this device. Your publication's own
        pages keep the appearance you give them.
      </p>
    </div>
  );
}
