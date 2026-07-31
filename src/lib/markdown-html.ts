/**
 * Markdown → HTML, for the places that need HTML rather than React.
 *
 * There is exactly one of those today: `<content:encoded>` in the RSS feeds,
 * which carries a post's full text to feed readers. The reader page renders
 * the same markdown through react-markdown (~/components/prose), so this
 * pipeline is deliberately assembled from THE SAME plugins in the same order —
 * remark-parse, remark-gfm, remark-rehype — and differs only in the last step,
 * where prose builds React elements and this builds a string. A feed that
 * renders differently from the page is a bug the day someone notices; sharing
 * the plugin list is how that stays impossible rather than merely unlikely.
 *
 * RAW HTML IS DROPPED, and that is the same decision the reader makes.
 * `remark-rehype` ignores raw HTML unless it is handed
 * `allowDangerousHtml: true`, which is the string-pipeline equivalent of the
 * `rehype-raw` that prose deliberately does not use. The markdown here came
 * out of a record on somebody's PDS and is not ours to trust; a `<script>` in
 * a post body must reach a feed reader as text or not at all.
 */
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

// Built once. The processor is stateless across runs (unified freezes it on
// first use), and rebuilding it per feed item would pay the setup cost twenty
// times inside a 10 ms CPU budget.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

/**
 * Renders markdown to an HTML fragment — no document, no wrapper element.
 *
 * Returns "" for anything that isn't a non-empty string, and for markdown that
 * renders to nothing. Callers treat "" as "no content" and omit the element
 * rather than emitting an empty one.
 */
export function markdownToHtml(markdown: unknown): string {
  if (typeof markdown !== "string" || markdown.trim() === "") return "";
  return String(processor.processSync(markdown)).trim();
}
