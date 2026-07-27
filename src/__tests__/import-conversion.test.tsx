/**
 * The import pipeline's conversion step, against realistic Substack-shaped
 * HTML: a headless BlockNoteEditor + tryParseHTMLToBlocks in jsdom — the
 * same call the /import page makes in the browser. Pins the two properties
 * the design leans on:
 *   1. conversion is the sanitizer (script/iframe/unknown nodes are
 *      structurally dropped, never carried into blocks), and
 *   2. real content survives visibly (headings, paragraphs, lists, images) —
 *      unmappable content must degrade to text, not vanish.
 */
import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

const SUBSTACK_HTML = `
<h2>The state of the newsletter</h2>
<p>First paragraph with <strong>bold</strong> and a
   <a href="https://example.com/ref">reference link</a>.</p>
<div class="captioned-image-container"><figure>
  <a class="image-link" href="https://substackcdn.com/image/fetch/w_1456/img.jpg">
    <img src="https://substackcdn.com/image/fetch/w_720/img.jpg" alt="A chart">
  </a>
  <figcaption>The chart, captioned.</figcaption>
</figure></div>
<ul><li>point one</li><li>point two</li></ul>
<blockquote><p>A pull quote.</p></blockquote>
<p>Closing words.</p>`;

type Block = {
  type: string;
  content?: unknown;
  props?: Record<string, unknown>;
  children?: Block[];
};

function blockTypes(blocks: Block[]): string[] {
  return blocks.flatMap((b) => [b.type, ...blockTypes(b.children ?? [])]);
}

function textOf(blocks: Block[]): string {
  return JSON.stringify(blocks);
}

describe("tryParseHTMLToBlocks — the import conversion step", () => {
  const editor = BlockNoteEditor.create();

  it("converts Substack-shaped HTML into visible blocks", () => {
    const blocks = editor.tryParseHTMLToBlocks(SUBSTACK_HTML) as Block[];
    expect(blocks.length).toBeGreaterThan(3);
    const types = blockTypes(blocks);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("bulletListItem");
    const text = textOf(blocks);
    expect(text).toContain("First paragraph");
    expect(text).toContain("point two");
    expect(text).toContain("Closing words.");
  });

  it("keeps body images as image blocks (hotlinked URLs — by design)", () => {
    const blocks = editor.tryParseHTMLToBlocks(SUBSTACK_HTML) as Block[];
    const types = blockTypes(blocks);
    expect(types).toContain("image");
    expect(textOf(blocks)).toContain("substackcdn.com");
  });

  it("structurally drops script/iframe/event handlers (conversion IS the sanitizer)", () => {
    const hostile = `<p>before</p>
<script>alert("xss")</script>
<iframe src="https://evil.example"></iframe>
<img src="x" onerror="alert(1)">
<p onmouseover="alert(2)">after</p>`;
    const blocks = editor.tryParseHTMLToBlocks(hostile) as Block[];
    const text = textOf(blocks);
    expect(text).not.toContain("alert(");
    expect(text).not.toContain("onerror");
    expect(text).not.toContain("onmouseover");
    expect(text).not.toContain("evil.example");
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  it("returns a single EMPTY paragraph for empty input (pinned: the page's blank-detection depends on this shape)", () => {
    const blocks = editor.tryParseHTMLToBlocks("") as Block[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toEqual([]);
  });

  it("blocks round-trip through JSON (what /api/import/draft stores)", () => {
    const blocks = editor.tryParseHTMLToBlocks(SUBSTACK_HTML);
    const roundTripped = JSON.parse(JSON.stringify(blocks));
    expect(Array.isArray(roundTripped)).toBe(true);
    expect(roundTripped.length).toBe(blocks.length);
  });
});
