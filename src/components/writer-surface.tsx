import { type BasicTheme, themeStyle } from "~/lib/theme";
import { cn } from "~/lib/utils";

/**
 * The page shell for a surface that belongs to its AUTHOR — the publication
 * page and the post pages, and nothing else.
 *
 * This is the counterpart to `.goldroad-surface`: that class marks the pages
 * whose appearance is ours to set (marketing, app chrome, the editor, which
 * follow the reader's dark-mode toggle). This one marks the pages whose
 * appearance is the writer's, which follow their theme and never our toggle.
 * A page is one or the other, never both.
 *
 * `theme` is whatever `parseTheme` returned for the author's publication
 * record — null for no theme, a malformed theme, a partial one, or an author
 * who never heard of Goldroad. Null renders the default palette and no
 * `data-writer-theme` attribute, so an absent theme and a rejected theme are
 * indistinguishable to everything downstream. That is the intent: a theme we
 * could not fully validate must not be able to half-apply.
 */
export function WriterSurface({
  children,
  className,
  theme,
}: {
  children: React.ReactNode;
  className?: string;
  theme?: BasicTheme | null;
}) {
  return (
    <div
      className={cn("min-h-screen bg-paper font-body text-ink", className)}
      // Presence is the signal; the value is never read. Only set for a theme
      // that survived validation.
      data-writer-theme={theme ? "" : undefined}
      style={themeStyle(theme)}
    >
      {children}
    </div>
  );
}
