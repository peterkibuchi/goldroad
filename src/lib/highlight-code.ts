/**
 * Syntax highlighting for the fenced code in a post body, in the browser.
 *
 * Loaded by Prose only on a post whose body has a code block that names its
 * language, so every other post pays nothing for it, and the Worker does no
 * work for it at all: the renderer (~/lib/markdown-html) already marks each
 * block `language-*`, and this colours it after the page is up. With
 * JavaScript off, or for a language not listed here, the block stays the
 * plain monospace it was rendered as.
 *
 * highlight.js (BSD-3-Clause, which AGPL-3.0 can carry) rather than Shiki or
 * Prism. Shiki ships a regex engine or WebAssembly and full TextMate grammars,
 * far more than a reading page should load for a few blocks. Prism's language
 * files register on a global and expect to run in a fixed order. highlight.js
 * has a small core and one ES module per language, so a post with Python in it
 * loads the core and Python's grammar and nothing else, and its output escapes
 * the code text itself.
 *
 * No guessing a block's language: auto-detection needs every grammar loaded
 * to score the text, and it guesses wrong on short snippets. A block without a
 * language is the writer saying "plain".
 */
import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";

import "./highlight-code.css";

type Grammar = () => Promise<{ default: LanguageFn }>;

/** The grammars a post can use, each its own chunk. */
const GRAMMARS: Record<string, Grammar> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/** The other names writers put after the fence. Keys are lowercase. */
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  h: "c",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  "c#": "csharp",
  patch: "diff",
  docker: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  golang: "go",
  gql: "graphql",
  hs: "haskell",
  toml: "ini",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsonc: "json",
  kt: "kotlin",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  html: "xml",
  svg: "xml",
  yml: "yaml",
};

/** The language a block names (`language-ts` → "ts"), lowercased. */
export function blockLanguage(code: Element): string | null {
  for (const name of code.classList)
    if (name.startsWith("language-")) return name.slice(9).toLowerCase();
  return null;
}

/** Each grammar is fetched and registered once per page, however many blocks
 * use it; the promise is the registration. */
const registered = new Map<string, Promise<void>>();
function register(name: string): Promise<void> {
  let ready = registered.get(name);
  if (!ready) {
    ready = GRAMMARS[name]().then(
      (module) => hljs.registerLanguage(name, module.default),
      (error) => {
        // Forget a failed fetch, so the next post that needs it tries again.
        registered.delete(name);
        throw error;
      },
    );
    registered.set(name, ready);
  }
  return ready;
}

/** About 500 lines of typical code. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * Highlights every fenced block in `root` that names a language we carry.
 * Safe to call twice on the same body: a block is marked once it is done.
 */
export async function highlightCode(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre > code[class*='language-']:not([data-highlighted])",
  );
  await Promise.all(
    Array.from(blocks, async (code) => {
      const asked = blockLanguage(code) ?? "";
      const language = Object.hasOwn(ALIASES, asked) ? ALIASES[asked] : asked;
      if (!Object.hasOwn(GRAMMARS, language)) return;
      // Highlighting runs on the main thread in one go; a block this long
      // would hold the page up for longer than its colours are worth.
      if ((code.textContent ?? "").length > MAX_HIGHLIGHT_CHARS) return;
      // A grammar that fails to load leaves the block plain, as it was.
      const ok = await register(language).then(
        () => true,
        () => false,
      );
      if (!ok || code.dataset.highlighted !== undefined) return;
      // highlight.js escapes the text it is given and adds only its own
      // <span class="hljs-…"> elements, so this is no less safe than the
      // escaped text the server rendered.
      code.innerHTML = hljs.highlight(code.textContent ?? "", {
        language,
        ignoreIllegals: true,
      }).value;
      code.dataset.highlighted = "";
    }),
  );
}
