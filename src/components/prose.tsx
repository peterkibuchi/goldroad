/**
 * The writer's body on a reading page, as HTML from ~/lib/markdown-html,
 * which is where the safety rules live: raw HTML escaped, links and images
 * limited to safe URLs. Rendered on the server (or once in the loader on
 * client navigation) and never re-parsed during hydration.
 *
 * `gr-prose` is a styling hook: it marks the writer's own prose so a themed
 * page can put their accent on the links inside it without recolouring page
 * chrome (see [data-writer-theme] in styles.css).
 */
export function Prose({ html }: { html: string }) {
  return (
    <div
      className="gr-prose wrap-anywhere text-[1.0625rem] leading-[1.7]"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markdownToHtml escapes raw HTML and filters URLs
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
