import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it, vi } from "vitest";

/**
 * The editor's embed block. Its one job beyond showing a preview is to change
 * nothing about what is stored: the markdown must be the bare link alone on
 * its line, and reopening that markdown must give the block back.
 */
import {
  editorSchema,
  embedPasteHandler,
  withEmbedBlocks,
} from "../components/embed-block";

const URL_ = "https://www.youtube.com/watch?v=dQw4w9WgX_Q&t=42s";

function editor() {
  return BlockNoteEditor.create({ schema: editorSchema });
}

function paste(
  instance: ReturnType<typeof editor>,
  text: string,
): { handled: boolean | undefined; fallback: ReturnType<typeof vi.fn> } {
  const fallback = vi.fn(() => true);
  const handled = embedPasteHandler({
    event: {
      clipboardData: { getData: () => text },
    } as unknown as ClipboardEvent,
    editor: instance as never,
    defaultPasteHandler: fallback,
  });
  return { handled, fallback };
}

describe("the embed block", () => {
  it("exports as the bare link alone on its line", () => {
    const instance = editor();
    instance.replaceBlocks(instance.document, [
      { type: "paragraph", content: "Before" },
      { type: "embed", props: { url: URL_ } },
      { type: "paragraph", content: "After" },
    ]);
    expect(instance.blocksToMarkdownLossy(instance.document)).toBe(
      `Before\n\n${URL_}\n\nAfter\n`,
    );
  });

  it("comes back from that markdown as the same block", () => {
    const instance = editor();
    const blocks = withEmbedBlocks(
      instance.tryParseMarkdownToBlocks(`Before\n\n${URL_}\n\nAfter`),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "embed",
      "paragraph",
    ]);
    expect((blocks[1] as { props: { url: string } }).props.url).toBe(URL_);
  });

  it("leaves a link that has company, or isn't a provider's, as it was", () => {
    const instance = editor();
    for (const md of [
      `Watch ${URL_}`,
      "https://example.com/page",
      `[watch](${URL_})`,
      // Formatting the writer chose; the page doesn't play these either.
      `\`${URL_}\``,
      `**${URL_}**`,
    ]) {
      const blocks = withEmbedBlocks(instance.tryParseMarkdownToBlocks(md));
      expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
    }
  });
});

describe("pasting a link", () => {
  it("on an empty line makes an embed, and carries on writing below it", () => {
    const instance = editor();
    instance.replaceBlocks(instance.document, [{ type: "paragraph" }]);
    instance.setTextCursorPosition(instance.document[0], "start");
    const { handled, fallback } = paste(instance, `  ${URL_}\n`);
    expect(handled).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(instance.document.map((b) => b.type)).toEqual([
      "embed",
      "paragraph",
    ]);
    expect(instance.getTextCursorPosition().block.id).toBe(
      instance.document[1].id,
    );
  });

  it("into a line that already has words pastes as it always did", () => {
    const instance = editor();
    instance.replaceBlocks(instance.document, [
      { type: "paragraph", content: "Some words" },
    ]);
    instance.setTextCursorPosition(instance.document[0], "end");
    const { fallback } = paste(instance, URL_);
    expect(fallback).toHaveBeenCalled();
    expect(instance.document[0].type).toBe("paragraph");
  });

  it("anything but a lone provider link pastes as it always did", () => {
    const instance = editor();
    instance.replaceBlocks(instance.document, [{ type: "paragraph" }]);
    instance.setTextCursorPosition(instance.document[0], "start");
    for (const text of [`${URL_} and more`, "https://example.com/x", ""]) {
      const { fallback } = paste(instance, text);
      expect(fallback).toHaveBeenCalled();
    }
    expect(instance.document[0].type).toBe("paragraph");
  });
});
