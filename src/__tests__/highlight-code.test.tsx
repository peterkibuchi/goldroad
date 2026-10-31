/**
 * Code highlighting on the reading page: loaded only for a body with a block
 * that names its language, applied in place, and never a way for the code's
 * own text to become markup.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blockLanguage,
  highlightCode,
  MAX_HIGHLIGHT_CHARS,
} from "#/lib/highlight-code";
import { markdownToHtml } from "#/lib/markdown-html";
import { Prose } from "../components/prose";

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("~/lib/highlight-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/highlight-code")>();
  return {
    ...actual,
    highlightCode: (root: HTMLElement) => {
      loaded.count++;
      return actual.highlightCode(root);
    },
  };
});

afterEach(() => {
  cleanup();
  loaded.count = 0;
});

const body = (markdown: string) => {
  const root = document.createElement("div");
  root.innerHTML = markdownToHtml(markdown);
  return root;
};

describe("highlightCode", () => {
  it("colours a block in the language it names, keeping its text", async () => {
    const root = body("```ts\nconst answer: number = 42; // the answer\n```");
    await highlightCode(root);
    const code = root.querySelector("code");
    expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code?.querySelector(".hljs-number")?.textContent).toBe("42");
    expect(code?.querySelector(".hljs-comment")?.textContent).toBe(
      "// the answer",
    );
    expect(code?.textContent).toBe(
      "const answer: number = 42; // the answer\n",
    );
  });

  it("knows a language by the names writers use for it", async () => {
    const root = body("```PY\ndef f():\n    return 'x'\n```");
    await highlightCode(root);
    expect(root.querySelector(".hljs-keyword")?.textContent).toBe("def");
  });

  it("leaves a block without a language, or in one it doesn't carry, plain", async () => {
    const root = body("```\nconst x = 1;\n```\n\n```brainfuck\n+++.\n```");
    const before = root.innerHTML;
    await highlightCode(root);
    expect(root.innerHTML).toBe(before);
  });

  it("leaves a block too long to colour quickly plain", async () => {
    const line = "let a = 1;\n";
    const lines = Math.ceil(MAX_HIGHLIGHT_CHARS / line.length) + 1;
    const root = body(`\`\`\`js\n${line.repeat(lines)}\`\`\``);
    await highlightCode(root);
    expect(root.querySelector(".hljs-keyword")).toBeNull();
  });

  it("keeps markup in the code as text", async () => {
    const root = body(
      '```html\n<img src=x onerror="window.pwned = true">\n<script>alert(1)</script>\n```',
    );
    await highlightCode(root);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("code")?.textContent).toContain(
      '<img src=x onerror="window.pwned = true">',
    );
  });

  it("highlights a block once, however often it is asked", async () => {
    const root = body("```js\nlet a = 1;\n```");
    await highlightCode(root);
    const once = root.innerHTML;
    await highlightCode(root);
    expect(root.innerHTML).toBe(once);
  });

  it("reads the language off the block's class", () => {
    const code = document.createElement("code");
    code.className = "rounded-sm language-Rust";
    expect(blockLanguage(code)).toBe("rust");
    code.className = "rounded-sm";
    expect(blockLanguage(code)).toBeNull();
  });
});

describe("Prose", () => {
  it("loads the highlighter for a body with a block that names its language", async () => {
    const { container } = render(
      <Prose html={markdownToHtml("Some code:\n\n```js\nlet a = 1;\n```")} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".hljs-keyword")).not.toBeNull(),
    );
    expect(loaded.count).toBe(1);
  });

  it("loads nothing for a body without one", async () => {
    render(
      <Prose
        html={markdownToHtml(
          "Just words, and `inline code`.\n\n```\nplain\n```\n\n```text\nalso plain\n```",
        )}
      />,
    );
    // Long enough for a dynamic import that was going to happen to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loaded.count).toBe(0);
  });
});
