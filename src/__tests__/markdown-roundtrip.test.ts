/**
 * BlockNote blocks → markdown → blocks round-trip sanity. The export is
 * officially lossy — these tests pin down that the v1
 * feature set (headings, emphasis, lists, quotes, code) survives the trip,
 * so the /write edit flow can re-open published posts without corruption.
 *
 * Runs headless: BlockNoteEditor.create() under jsdom, no mounted view.
 */
import { type Block, BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

function createEditor() {
  return BlockNoteEditor.create();
}

function texts(block: Block): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
    .join("");
}

describe("blocks → markdown → blocks", () => {
  it("preserves the v1 block set: heading, paragraph, lists, quote, code", () => {
    const editor = createEditor();
    const markdown = editor.blocksToMarkdownLossy([
      { type: "heading", props: { level: 2 }, content: "Section" },
      { type: "paragraph", content: "Plain prose." },
      { type: "bulletListItem", content: "first" },
      { type: "bulletListItem", content: "second" },
      { type: "numberedListItem", content: "step one" },
      { type: "quote", content: "quoted words" },
      { type: "codeBlock", content: "const x = 1;" },
    ]);

    expect(markdown).toContain("## Section");
    expect(markdown).toContain("Plain prose.");
    expect(markdown).toMatch(/[-*] first/);
    expect(markdown).toMatch(/1\. step one/);
    expect(markdown).toContain("> quoted words");
    expect(markdown).toContain("const x = 1;");

    const back = createEditor().tryParseMarkdownToBlocks(markdown);
    const types = back.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "paragraph",
      "bulletListItem",
      "bulletListItem",
      "numberedListItem",
      "quote",
      "codeBlock",
    ]);
    expect(back[0]?.props).toMatchObject({ level: 2 });
    expect(texts(back[1] as Block)).toBe("Plain prose.");
    expect(texts(back[2] as Block)).toBe("first");
  });

  it("preserves inline marks and links", () => {
    const editor = createEditor();
    const markdown = editor.blocksToMarkdownLossy([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", styles: { bold: true } },
          { type: "text", text: " and ", styles: {} },
          {
            type: "link",
            href: "https://example.com",
            content: [{ type: "text", text: "a link", styles: {} }],
          },
        ],
      },
    ]);
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("[a link](https://example.com)");

    const back = createEditor().tryParseMarkdownToBlocks(markdown);
    const content = back[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const flat = JSON.stringify(content);
    expect(flat).toContain('"bold":true');
    expect(flat).toContain("https://example.com");
  });

  it("re-imports plain multi-paragraph prose as paragraphs (v0 records stay editable)", () => {
    const back = createEditor().tryParseMarkdownToBlocks(
      "First paragraph.\n\nSecond paragraph.",
    );
    expect(back.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(texts(back[0] as Block)).toBe("First paragraph.");
    expect(texts(back[1] as Block)).toBe("Second paragraph.");
  });

  it("keeps raw HTML in markdown as text-level content, not structure", () => {
    // A writer pasting "<script>" into a paragraph must never round-trip into
    // anything executable — the reader renders markdown with raw HTML inert.
    const editor = createEditor();
    const markdown = editor.blocksToMarkdownLossy([
      { type: "paragraph", content: "literal <script>alert(1)</script> text" },
    ]);
    const back = createEditor().tryParseMarkdownToBlocks(markdown);
    expect(back.map((b) => b.type)).not.toContain("script");
    expect(texts(back[0] as Block)).toContain("literal");
  });
});
