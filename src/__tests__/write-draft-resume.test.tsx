import { BlockNoteEditor } from "@blocknote/core";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Resuming a draft, when the stored block JSON isn't loadable.
 *
 * The guard on that JSON was `Array.isArray && length > 0`, and its comment
 * promised the editor "starts empty rather than crashing the resume". A
 * non-empty array of anything at all passed it — and each kind of garbage
 * breaks BlockNote somewhere different while it rewrites the document, which
 * is pinned below against the real editor.
 *
 * "Starts empty" was never the recovery it sounded like either: the writer
 * opens a blank page over a draft that still holds their words, and the first
 * keystroke autosaves the blank document back over them. So the check is on
 * every entry now, and the markdown projection saved alongside the blocks is
 * what the editor falls back to.
 */
import Editor from "../components/editor";
import { parseDraftBlocks } from "../routes/write";

afterEach(cleanup);

/** Rows a draft table can genuinely hold: a truncated write, a hand-edited
 * export, a column that predates a schema change. */
const UNLOADABLE = {
  "an array of numbers": "[1,2,3]",
  "an array of strings": '["not a block"]',
  "a null entry": "[null]",
  "a nested array": "[[]]",
  "an object with no type": '[{"content":[]}]',
  "a numeric content field": '[{"type":"paragraph","content":42}]',
  "unloadable children": '[{"type":"paragraph","children":[null]}]',
};

/**
 * A table, built by the editor itself rather than hand-written: its `content`
 * is the one shape in the default schema that is neither a string nor an array,
 * and the point of building it this way is that nothing here has to claim what
 * that shape is.
 */
function storedTableDocument(): string {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, [
    { type: "paragraph", content: "Comparison" },
    {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          {
            cells: [
              [{ type: "text", text: "Goldroad", styles: {} }],
              [{ type: "text", text: "0%", styles: {} }],
            ],
          },
        ],
      },
    },
  ]);
  return JSON.stringify(editor.document);
}

describe("parseDraftBlocks", () => {
  it("keeps a document the editor can actually load", () => {
    const blocks = '[{"type":"paragraph","content":[]}]';
    expect(parseDraftBlocks(blocks)).toEqual([
      { type: "paragraph", content: [] },
    ]);
    // Children are blocks too, and are checked the same way.
    expect(
      parseDraftBlocks(
        '[{"type":"bulletListItem","children":[{"type":"paragraph"}]}]',
      ),
    ).toHaveLength(1);
  });

  /**
   * A table's content is an OBJECT, and the shape check accepted only undefined,
   * a string or an array — so one table failed the whole document (the check is
   * `every`). The draft then resumed from the lossy markdown projection, where a
   * table is at best pipes and dashes, and the next autosave wrote that back
   * over the lossless blocks. Losing a table by opening the draft is exactly the
   * failure this guard was added to prevent.
   */
  it("keeps a document containing a table", () => {
    const stored = storedTableDocument();
    const blocks = parseDraftBlocks(stored);
    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks)).toBe(stored);

    // And it is still a table once the editor has it back, cells and all.
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, blocks as never);
    const reloaded = JSON.stringify(editor.document);
    expect(reloaded).toContain('"type":"table"');
    expect(reloaded).toContain('"text":"Goldroad"');
    expect(reloaded).toContain('"text":"0%"');
  });

  it("refuses every row shape the editor would choke on", () => {
    for (const [name, json] of Object.entries(UNLOADABLE)) {
      expect(parseDraftBlocks(json), name).toBeUndefined();
    }
  });

  it("still refuses what it always refused", () => {
    expect(parseDraftBlocks(undefined)).toBeUndefined();
    expect(parseDraftBlocks("")).toBeUndefined();
    expect(parseDraftBlocks("[]")).toBeUndefined();
    expect(parseDraftBlocks("not json")).toBeUndefined();
  });

  /** Why the shape check exists at all: hand each of these to the REAL editor
   * and none of them becomes a document. Most throw partway through the
   * rewrite; the rest land as blank paragraphs. Either way the row is not a
   * draft, so it must never reach the editor as one. */
  it("refuses payloads the real editor cannot turn into a document", () => {
    for (const [name, json] of Object.entries(UNLOADABLE)) {
      const editor = BlockNoteEditor.create();
      let threw = false;
      try {
        editor.replaceBlocks(editor.document, JSON.parse(json));
      } catch {
        threw = true;
      }
      const blank = !/"text":"[^"]/.test(JSON.stringify(editor.document));
      expect(threw || blank, name).toBe(true);
    }
  });
});

describe("the editor's fallback when stored blocks won't load", () => {
  function documentText(editor: BlockNoteEditor): string {
    return JSON.stringify(editor.document);
  }

  it("loads the markdown projection instead of opening blank", async () => {
    let editor: BlockNoteEditor | null = null;
    render(
      <Editor
        initialBlocks={[null]}
        initialMarkdown="The words the writer actually typed."
        onReady={(instance) => {
          editor = instance;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    expect(documentText(editor as unknown as BlockNoteEditor)).toContain(
      "The words the writer actually typed.",
    );
  });

  /**
   * The shape check lets any plain object through as `content` because that is
   * what a table carries, so an object that ISN'T content reaches the editor and
   * throws there. That is the same recovery, not a new hole: the editor catches
   * it and loads the words.
   */
  it("still recovers when an object turns out not to be content", async () => {
    let editor: BlockNoteEditor | null = null;
    render(
      <Editor
        initialBlocks={[{ type: "paragraph", content: { nonsense: true } }]}
        initialMarkdown="The words the writer actually typed."
        onReady={(instance) => {
          editor = instance;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    expect(documentText(editor as unknown as BlockNoteEditor)).toContain(
      "The words the writer actually typed.",
    );
  });

  it("prefers the blocks when they load — markdown is lossy", async () => {
    let editor: BlockNoteEditor | null = null;
    render(
      <Editor
        initialBlocks={[
          {
            type: "paragraph",
            content: [{ type: "text", text: "Lossless", styles: {} }],
          },
        ]}
        initialMarkdown="The lossy projection"
        onReady={(instance) => {
          editor = instance;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    const text = documentText(editor as unknown as BlockNoteEditor);
    expect(text).toContain("Lossless");
    expect(text).not.toContain("The lossy projection");
  });
});
