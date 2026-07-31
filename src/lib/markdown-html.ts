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
 * How much markdown one request may parse, in characters, across all items.
 *
 * A CPU budget expressed in the only unit a caller can check BEFORE paying it.
 * A Workers free-tier invocation gets 10 ms of CPU, and this parse is the most
 * expensive thing the feed does. Measured with this exact plugin list, warm,
 * on realistic prose (links, emphasis, headings, inline code):
 *
 * | markdown | CPU |
 * | 2 000 chars | ~4.5 ms |
 * | 4 000 chars | ~7.2 ms |
 * | 6 000 chars | ~10.0 ms — the entire budget, with nothing left over |
 * | 10 000 chars | ~32 ms |
 * | 50 × 20 000 (one full feed page) | ~3 000 ms |
 *
 * The cost grows faster than the input because inline parsing dominates, so
 * halving the budget more than halves the risk. 2 000 spends under half the
 * invocation and leaves the rest for reading the records and building the XML.
 *
 * It is a whole-request budget, not a per-item cap: fifty items that each fit a
 * per-item cap still add up to a terminated Worker.
 *
 * CONSEQUENCE, stated plainly: only short posts carry full text today. Anything
 * longer falls back to its excerpt. Removing this ceiling means not parsing at
 * request time at all — rendering the HTML once when a post is published and
 * storing it — which is the fix this constant is standing in for.
 */
export const MARKDOWN_PARSE_BUDGET_CHARS = 2_000;

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

/**
 * A budget for rendering many documents in one request, spent newest-first.
 *
 * `render` returns "" once the budget can't cover the next document, and the
 * caller omits the element for that item — a feed reader then falls back to the
 * item's `description`, which is a cheap bounded excerpt. Refusing to start is
 * the point: truncating markdown mid-document is how you emit a dangling
 * emphasis run or half a code fence, and the parse has already been paid by the
 * time you could measure the output.
 */
export function markdownBudget(limit = MARKDOWN_PARSE_BUDGET_CHARS) {
  let remaining = limit;
  return {
    render(markdown: unknown): string {
      if (typeof markdown !== "string" || markdown.trim() === "") return "";
      if (markdown.length > remaining) return "";
      remaining -= markdown.length;
      return markdownToHtml(markdown);
    },
    /** Characters still available — for assertions, not for callers to branch on. */
    get remaining() {
      return remaining;
    },
  };
}
