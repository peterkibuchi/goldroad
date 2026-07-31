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
  if (next === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}
