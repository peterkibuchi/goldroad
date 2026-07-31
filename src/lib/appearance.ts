/**
 * Which edition a reader is in, and how they change it.
 *
 * One home for the preference because it is read in three places that must
 * agree: the blocking bootstrap in __root.tsx (which sets `data-theme` before
 * first paint, so nobody sees a flash of the wrong edition), the control in the
 * app and marketing chrome, and the control at the foot of a reading page. A
 * key spelled differently in any one of them is a silent bug — the toggle
 * appears to work and the preference is forgotten on the next page.
 *
 * `data-theme` on <html> is the live state; localStorage is only the memory of
 * it. Absence means "follow the system", which is why the attribute is DELETED
 * rather than set to "light": a stored "light" is a choice, and no attribute at
 * all lets `prefers-color-scheme` speak on the next load.
 */

/** localStorage key. Also interpolated into the pre-paint bootstrap. */
export const APPEARANCE_KEY = "gr-appearance";

export type Edition = "light" | "dark";

/** The edition currently painted, read off the DOM rather than from storage —
 * the bootstrap has already reconciled a stored choice with the system one, so
 * the attribute is the answer and storage is not. */
export function currentEdition(): Edition {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Switch editions: remember the choice, then repaint.
 *
 * Storage failure (private mode, a refusing browser) must not stop the
 * repaint — the reader asked for a different edition and should get it for this
 * page even if we cannot remember it for the next.
 */
export function setEdition(next: Edition): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, next);
  } catch {
    // Preference is a nicety; the repaint below is the actual request.
  }
  const root = document.documentElement;
  if (next === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  // Choosing by hand is what earns the override of a writer's theme — see the
  // bootstrap in __root.tsx. Setting it here keeps a switch made on this page
  // effective on this page, not only after the next load.
  root.dataset.readerEdition = next;
}

/**
 * Back to deferring: the system decides our surfaces, and an author's theme
 * decides theirs.
 *
 * The third state, and the one that makes the override safe to offer — without
 * a way back, a reader who once tapped "dark" could never see a writer's
 * colours again. Removing the stored value rather than storing "system" means
 * an untouched reader and a reset one are the same reader.
 */
export function clearEdition(): void {
  try {
    localStorage.removeItem(APPEARANCE_KEY);
  } catch {
    // Same as above: the repaint is the request.
  }
  const root = document.documentElement;
  delete root.dataset.readerEdition;
  if (prefersDark()) root.dataset.theme = "dark";
  else delete root.dataset.theme;
}

/**
 * Does the system ask for dark?
 *
 * Guarded, because `matchMedia` is not guaranteed: it is absent in a plain
 * jsdom and in some embedded webviews, and an unguarded call turns "hand this
 * page back to its author" into a thrown exception. The pre-paint bootstrap
 * already wraps its own call in a try/catch for the same reason; this is that
 * caution applied to the path that runs after mount.
 *
 * False on absence, which lands on the light edition — the same answer a
 * browser that has never heard of `prefers-color-scheme` gives.
 */
function prefersDark(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}
