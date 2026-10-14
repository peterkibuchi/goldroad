/**
 * Markdown → HTML for every surface that shows a post body: the reading page
 * (~/components/prose) and `<content:encoded>` in the RSS feeds. One renderer,
 * one output, so the feed can never drift from the page, and one cache entry
 * per body serves both.
 *
 * markdown-it rather than react-markdown + remark: on a 15,000-character essay
 * it costs about 5 ms of CPU against about 60 ms, inside a 10 ms Worker budget.
 *
 * The output goes into the page as HTML, so it must be safe by construction,
 * and markdown text comes from anybody's PDS:
 * - `html: false`: raw HTML in the source is escaped and shows as text, as it
 *   did under react-markdown. It never becomes markup.
 * - A link or image whose URL fails `isSafeUrl` (relative, or a protocol on
 *   the allowlist) loses its href/src, as under react-markdown's urlTransform.
 * - Every other byte is markdown-it's own escaped text. The only markup added
 *   here is constant strings and escaped values.
 *
 * Two outputs, one difference: on the reading page (`embeds: true`) a bare
 * link alone on its own line to a video, song or Bluesky post becomes a
 * click-to-load preview (~/lib/embeds). The feed keeps it a plain link: feed
 * readers run no scripts, and the link is what the writer wrote.
 */
import MarkdownIt, { type StateCore, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";

import {
  type Embed,
  embedLabel,
  framePath,
  parseEmbed,
  playerSize,
  thumbnailPath,
} from "~/lib/embeds";
import { defaultCache } from "~/lib/workers-cache";

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/** Relative URLs pass; absolute ones need an allowlisted protocol. */
export function isSafeUrl(url: string): boolean {
  const colon = url.indexOf(":");
  if (colon === -1) return true;
  const firstDelimiter = url.search(/[/?#]/);
  if (firstDelimiter !== -1 && firstDelimiter < colon) return true;
  return SAFE_PROTOCOL.test(url.slice(0, colon));
}

/** Tailwind classes per output tag, kept as literals so Tailwind sees them. */
const CLASSES: Record<string, string> = {
  p: "mt-5 first:mt-0",
  a: "underline decoration-ink/30 underline-offset-2 transition-colors hover:decoration-ink",
  ul: "mt-5 list-disc space-y-2 pl-6",
  ol: "mt-5 list-decimal space-y-2 pl-6",
  li: "pl-1",
  blockquote:
    "mt-6 border-ink border-l-2 pl-6 text-[1.125rem] text-ink-soft leading-relaxed",
  code: "rounded-sm bg-ink/5 px-1 font-mono text-[0.9em]",
  hr: "mt-10 border-rule border-t",
  img: "mt-5 max-w-full",
  table: "w-full border-collapse text-base",
  th: "border-rule border-b py-2 pr-4 text-left font-semibold",
  td: "border-rule border-b py-2 pr-4",
};
/** By SOURCE level: `#` renders as h2 (the document title owns h1). */
const HEADING_CLASSES = [
  "mt-12 text-balance font-semibold text-2xl leading-snug",
  "mt-10 text-balance font-semibold text-xl leading-snug",
  "mt-8 font-semibold text-lg",
  "mt-6 font-semibold",
  "mt-6 font-semibold",
  "mt-6 font-semibold text-base",
];
const PRE_CLASS =
  "mt-5 overflow-x-auto rounded-sm bg-ink/5 p-4 font-mono text-sm [&>code]:bg-transparent [&>code]:p-0";
const TABLE_WRAP_CLASS = "mt-5 overflow-x-auto";
const FOOTNOTES_CLASS =
  "footnotes mt-12 border-rule border-t pt-6 text-[0.9375rem] text-ink-soft";
const SUP_CLASS = "ml-px font-display text-[0.7em]";

const md = new MarkdownIt({ html: false, linkify: true }).use(footnote);
// Parse every link, then strip unsafe URLs in `decorate`: the text survives
// without a dangerous href, instead of showing the raw `[x](javascript:…)`.
md.validateLink = () => true;
// `^[inline]` footnotes aren't GFM; keep the syntax GFM readers expect.
md.inline.ruler.disable("footnote_inline");

function dropUnsafeUrl(token: Token, attr: string) {
  const url = token.attrGet(attr);
  if (url !== null && !isSafeUrl(String(url)))
    token.attrs = token.attrs?.filter(([name]) => name !== attr) ?? null;
}

/** Headings shift down a level, and every element gets its classes and safe
 * attributes. */
function decorate(tokens: Token[]) {
  for (const token of tokens) {
    if (token.children) decorate(token.children);
    if (token.type === "heading_open" || token.type === "heading_close") {
      const level = Number(token.tag.slice(1));
      token.tag = `h${Math.min(level + 1, 6)}`;
      if (token.nesting === 1)
        token.attrJoin("class", HEADING_CLASSES[level - 1]);
      continue;
    }
    if (token.type === "s_open" || token.type === "s_close") token.tag = "del"; // GFM's element
    if (token.nesting === -1) continue;
    const classes = CLASSES[token.tag];
    if (classes) token.attrJoin("class", classes);
    if (token.type === "link_open") {
      dropUnsafeUrl(token, "href");
      // Writer-supplied links: no referrer, no window.opener, no endorsement.
      token.attrSet("rel", "nofollow noopener noreferrer");
    } else if (token.type === "image") {
      dropUnsafeUrl(token, "src");
      token.attrSet("loading", "lazy");
    }
  }
}

/** GFM task lists: `- [ ] item` and `- [x] item` become disabled checkboxes,
 * as GitHub renders them. */
function taskLists(state: StateCore) {
  const { tokens } = state;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (
      inline.type !== "inline" ||
      tokens[i - 1].type !== "paragraph_open" ||
      tokens[i - 2].type !== "list_item_open"
    )
      continue;
    const match = /^\[([ xX])\] /.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || first?.type !== "text") continue;
    first.content = first.content.slice(4);
    const box = new state.Token("task_checkbox", "input", 0);
    box.meta = { checked: match[1] !== " " };
    inline.children?.unshift(box);
    tokens[i - 2].attrJoin("class", "task-list-item");
  }
}

/**
 * A paragraph that is nothing but one bare link (typed or pasted as a URL,
 * or an `<…>` autolink) to an embeddable page becomes an `embed` token. Only
 * at the top level: a link inside a list item or a quote is part of what
 * surrounds it. And only a bare link: `[watch this](…)` is the writer
 * choosing words, which stay a link.
 */
function embeds(state: StateCore) {
  if (!(state.env as RenderEnv | undefined)?.embeds) return;
  const { tokens } = state;
  for (let i = tokens.length - 3; i >= 0; i--) {
    const [open, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (
      open.type !== "paragraph_open" ||
      open.level !== 0 ||
      inline.type !== "inline" ||
      close.type !== "paragraph_close"
    )
      continue;
    const children = inline.children ?? [];
    const link = children[0];
    if (
      children.length !== 3 ||
      link.type !== "link_open" ||
      (link.markup !== "linkify" && link.markup !== "autolink") ||
      children[1].type !== "text" ||
      children[2].type !== "link_close"
    )
      continue;
    const href = String(link.attrGet("href") ?? "");
    const embed = parseEmbed(href);
    if (!embed) continue;
    const token = new state.Token("embed", "figure", 0);
    token.block = true;
    token.meta = { embed, href } satisfies EmbedMeta;
    tokens.splice(i, 3, token);
  }
}

type RenderEnv = { embeds?: boolean };
type EmbedMeta = { embed: Embed; href: string };

md.core.ruler.push("goldroad_embeds", embeds);
md.core.ruler.push("goldroad_decorate", (state) => {
  taskLists(state);
  decorate(state.tokens);
});

const rules = md.renderer.rules;
const escapeHtml = md.utils.escapeHtml;
const renderToken = md.renderer.renderToken.bind(md.renderer);

const BOXED =
  "overflow-hidden border border-rule bg-ink/5 transition-colors hover:border-ink";
const PLAY =
  "flex items-center justify-center rounded-full bg-ink text-paper transition-transform group-hover:scale-105 motion-reduce:transition-none";
const EMBED_CLASSES = {
  figure: "gr-embed mt-6 first:mt-0",
  preview: "gr-embed-preview group relative flex w-full text-ink no-underline",
  video: `${BOXED} aspect-video`,
  card: `${BOXED} items-center gap-4 p-4`,
  quote: "flex-col gap-1 border-ink border-l-2 py-1 pl-6",
  thumb: "absolute inset-0 h-full w-full object-cover",
  videoPlay: `${PLAY} relative m-auto h-14 w-14`,
  cardPlay: `${PLAY} h-11 w-11 shrink-0`,
  label: "min-w-0 font-display text-sm leading-snug",
  // A solid chip rather than text over the picture: a thumbnail can be any
  // colour at all, and the label has to read on every one of them.
  videoLabel: "absolute bottom-3 left-3 bg-ink px-2.5 py-1 text-paper",
  muted: "block truncate text-ink-soft text-xs",
};

const PLAY_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>';

/**
 * A click-to-load preview: an ordinary link to the original, which is what it
 * stays with scripts off (a click then opens the provider's own page), plus
 * the facts the page's script needs to swap it for a player in place (see
 * ~/components/prose). The only request it makes before that is for a YouTube
 * thumbnail, from our own origin.
 */
function embedHtml({ embed, href }: EmbedMeta): string {
  const { provider, kind } = embedLabel(embed);
  const size = playerSize(embed);
  const data = [
    `data-embed-frame="${escapeHtml(framePath(embed))}"`,
    `data-embed-title="${escapeHtml(`${provider} ${kind.toLowerCase()}`)}"`,
    "ratio" in size
      ? `data-embed-ratio="${size.ratio}"`
      : `data-embed-height="${size.height}"`,
  ].join(" ");
  const anchor = (classes: string, inner: string) =>
    `<a class="${EMBED_CLASSES.preview} ${classes}" href="${escapeHtml(href)}" rel="nofollow noopener noreferrer" ${data}>${inner}</a>`;
  let inner: string;
  const thumb = thumbnailPath(embed);
  if (thumb) {
    // A picture to show: the video's own frame, with the play button on it.
    inner = anchor(
      EMBED_CLASSES.video,
      `<img class="${EMBED_CLASSES.thumb}" src="${escapeHtml(thumb)}" alt="" loading="lazy"><span class="${EMBED_CLASSES.videoPlay}">${PLAY_ICON}</span><span class="${EMBED_CLASSES.label} ${EMBED_CLASSES.videoLabel}">Play ${kind.toLowerCase()} · ${provider}</span>`,
    );
  } else if (embed.provider !== "bluesky") {
    // Nothing to show without asking the provider, so a title card: an empty
    // 16:9 box would be a large grey promise of a picture.
    inner = anchor(
      EMBED_CLASSES.card,
      `<span class="${EMBED_CLASSES.cardPlay}">${PLAY_ICON}</span><span class="${EMBED_CLASSES.label}">Play ${kind.toLowerCase()} · ${provider}<span class="${EMBED_CLASSES.muted}">${escapeHtml(displayUrl(href))}</span></span>`,
    );
  } else {
    inner = anchor(
      EMBED_CLASSES.quote,
      `<span class="${EMBED_CLASSES.label} font-semibold">A post by @${escapeHtml(embed.actor)}</span><span class="${EMBED_CLASSES.label} text-ink-soft underline decoration-ink/30 underline-offset-2 group-hover:decoration-ink">Show the post from Bluesky</span>`,
    );
  }
  return `<figure class="${EMBED_CLASSES.figure}" data-embed="${embed.provider}">${inner}</figure>
`;
}

/** A URL shortened for a label: host and path, no scheme. */
function displayUrl(href: string): string {
  try {
    const url = new URL(href);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
  } catch {
    return href;
  }
}

rules.embed = (tokens, idx) => embedHtml(tokens[idx].meta as EmbedMeta);

rules.task_checkbox = (tokens, idx) =>
  `<input type="checkbox" disabled${(tokens[idx].meta as { checked: boolean }).checked ? " checked" : ""}> `;

rules.table_open = (tokens, idx, options) =>
  `<div class="${TABLE_WRAP_CLASS}">${renderToken(tokens, idx, options)}`;
rules.table_close = (tokens, idx, options) =>
  `${renderToken(tokens, idx, options)}</div>`;

const codeBlock = (content: string, info = "") => {
  const lang = md.utils.unescapeAll(info).trim().split(/\s+/)[0];
  const langClass = lang ? ` language-${escapeHtml(lang)}` : "";
  return `<pre class="${escapeHtml(PRE_CLASS)}"><code class="${CLASSES.code}${langClass}">${escapeHtml(content)}</code></pre>\n`;
};
rules.fence = (tokens, idx) => codeBlock(tokens[idx].content, tokens[idx].info);
rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content);

// Footnotes in GitHub's markup (its ids, data-footnote-* hooks, and a
// screen-reader-only heading), rather than the plugin's `[1]` and bare <hr>.
const footnoteNumber = (token: Token) => (token.meta as { id: number }).id + 1;
const footnoteId = (token: Token) => {
  const { subId } = token.meta as { subId: number };
  const n = footnoteNumber(token);
  return subId > 0 ? `${n}-${subId + 1}` : `${n}`;
};
rules.footnote_ref = (tokens, idx) => {
  const token = tokens[idx];
  const n = footnoteNumber(token);
  return `<sup class="${SUP_CLASS}"><a href="#user-content-fn-${n}" id="user-content-fnref-${footnoteId(token)}" data-footnote-ref aria-describedby="footnote-label" class="${CLASSES.a}">${n}</a></sup>`;
};
rules.footnote_block_open = () =>
  `<section data-footnotes class="${FOOTNOTES_CLASS}"><h2 class="sr-only" id="footnote-label">Footnotes</h2>\n<ol class="${CLASSES.ol}">\n`;
rules.footnote_block_close = () => "</ol>\n</section>\n";
rules.footnote_open = (tokens, idx) =>
  `<li id="user-content-fn-${footnoteNumber(tokens[idx])}" class="${CLASSES.li}">`;
rules.footnote_anchor = (tokens, idx) => {
  const id = footnoteId(tokens[idx]);
  return ` <a href="#user-content-fnref-${id}" data-footnote-backref aria-label="Back to reference ${escapeHtml(id)}" class="${CLASSES.a}">↩︎</a>`;
};

/** Inputs past these render as plain paragraphs. markdown-it is linear on
 * prose but not on bracket floods: 5,000 unclosed `[` cost ~100 ms, and a
 * hostile record must not cost every reader in the isolate. */
const MAX_RENDER_CHARS = 100_000;
const MAX_BRACKETS = 2_000;

function plainHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((para) => para.trim() !== "")
    .map((para) => `<p class="${CLASSES.p}">${escapeHtml(para)}</p>`)
    .join("\n");
}

function countBrackets(text: string): number {
  let n = 0;
  for (let i = text.indexOf("["); i !== -1; i = text.indexOf("[", i + 1)) n++;
  return n;
}

/**
 * Renders markdown to an HTML fragment — no document, no wrapper element.
 * Returns "" for anything that isn't a non-empty string; callers treat that
 * as "no content".
 */
export function markdownToHtml(
  markdown: unknown,
  options: RenderEnv = {},
): string {
  if (typeof markdown !== "string" || markdown.trim() === "") return "";
  if (
    markdown.length > MAX_RENDER_CHARS ||
    countBrackets(markdown) > MAX_BRACKETS
  )
    return plainHtml(markdown);
  return md.render(markdown, { embeds: options.embeds === true }).trim();
}

/** Bump on any change to the output (a test pins it), so old renders stop
 * matching. Keys hash the markdown itself, so they never go stale otherwise. */
export const RENDER_VERSION = 2;
const RENDER_CACHE_CONTROL = "public, max-age=2592000";

async function renderKey(
  markdown: string,
  embeds: boolean,
): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(markdown),
    );
    const hex = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    // The page and the feed render embeds differently, so never share.
    const variant = embeds ? "page" : "feed";
    return `https://goldroad-render.internal/v${RENDER_VERSION}/${variant}/${hex}`;
  } catch {
    return null;
  }
}

/**
 * `markdownToHtml` for several bodies, through the Workers Cache API. Keyed
 * by a hash of the markdown, so the key is derived from what we hold rather
 * than anything a PDS claims, and no entry can serve the wrong text.
 *
 * Lookups run in parallel; misses render in the order given while `mayRender`
 * allows, and "" otherwise. Callers run the takedown check first: the cache
 * only saves the render. Without a cache (tests, the browser on client-side
 * navigation) every body is a miss. Never throws.
 */
export async function renderBodies(
  bodies: readonly string[],
  mayRender: (markdown: string) => boolean = () => true,
  options: RenderEnv = {},
): Promise<string[]> {
  const cache = defaultCache();
  const embeds = options.embeds === true;
  const keys = await Promise.all(
    bodies.map((body) =>
      cache && body.trim() ? renderKey(body, embeds) : null,
    ),
  );
  const hits = await Promise.all(
    keys.map(async (key) => {
      if (!cache || !key) return undefined;
      try {
        return await (await cache.match(key))?.text();
      } catch {
        return undefined;
      }
    }),
  );
  const puts: Promise<unknown>[] = [];
  const html = bodies.map((body, i) => {
    const hit = hits[i];
    if (hit !== undefined) return hit;
    if (!body.trim() || !mayRender(body)) return "";
    let rendered: string;
    try {
      rendered = markdownToHtml(body, { embeds });
    } catch {
      rendered = plainHtml(body);
    }
    const key = keys[i];
    if (cache && key && rendered) {
      const response = new Response(rendered, {
        headers: {
          "cache-control": RENDER_CACHE_CONTROL,
          "content-type": "text/html; charset=utf-8",
        },
      });
      puts.push(cache.put(key, response).catch(() => {}));
    }
    return rendered;
  });
  await Promise.all(puts);
  return html;
}

/**
 * Markdown one feed request may render on cache misses, in characters: 5 to
 * 7 ms of CPU. The newest uncached post always renders, whatever its size;
 * the rest wait for a later request, and meanwhile fall back to the excerpt.
 */
export const FEED_RENDER_BUDGET_CHARS = 15_000;

/** A `mayRender` for one request, spent in call order. */
export function renderBudget(limit = FEED_RENDER_BUDGET_CHARS) {
  let remaining = limit;
  let rendered = false;
  return (markdown: string) => {
    if (rendered && markdown.length > remaining) return false;
    rendered = true;
    remaining -= markdown.length;
    return true;
  };
}
