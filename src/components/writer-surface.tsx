import { SkipToContent } from "~/components/skip-link";
import { type BasicTheme, themeStyle } from "~/lib/theme";
import { cn } from "~/lib/utils";

/**
 * The page shell for a surface that belongs to its AUTHOR — the publication
 * page and the post pages, and nothing else.
 *
 * This is the counterpart to `.goldroad-surface`: that class marks the pages
 * whose appearance is ours to set (marketing, app chrome, the editor). This one
 * marks the pages whose appearance is the author's. A page is one or the other,
 * never both.
 *
 * `theme` is whatever `parseTheme` returned for the author's publication
 * record — null for no theme, a malformed theme, a partial one, or an author
 * who never heard of Goldroad. Null renders the default palette and no
 * `data-writer-theme` attribute, so an absent theme and a rejected theme are
 * indistinguishable to everything downstream. That is the intent: a theme we
 * could not fully validate must not be able to half-apply.
 *
 * That attribute does double duty, and the second job is the reader's. It is
 * the record of whether the AUTHOR answered the question of how this page
 * looks. When they did, their answer stands over any reader preference. When
 * they did not, nobody has answered it but the reader — so an unthemed page
 * follows the reader's dark-mode choice rather than defaulting to white at
 * midnight, which is a default nobody chose. The `:not([data-writer-theme])`
 * rule in styles.css is that sentence in CSS.
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
      className={cn(
        "writer-surface min-h-screen bg-paper font-body text-ink",
        className,
      )}
      // Presence is the signal; the value is never read. Only set for a theme
      // that survived validation.
      data-writer-theme={theme ? "" : undefined}
      style={themeStyle(theme)}
    >
      {/* Reading surfaces render none of our chrome, but they still lead with
          the writer's masthead, their nav and (on a post) the article header
          before the words start. */}
      <SkipToContent />
      {children}
    </div>
  );
}
