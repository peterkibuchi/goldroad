/**
 * The editor's embed block: a YouTube or Vimeo video, a Spotify track or a
 * Bluesky post, pasted as a link on an empty line (~/lib/embeds decides which
 * links qualify).
 *
 * It exists for the writer's sake and changes nothing about what is stored:
 * the block exports as a paragraph holding the bare link, so the markdown is
 * the link alone on its line, the same thing a writer could have typed, and
 * every other app and feed reader sees a link. Reading pages turn that line
 * into a click-to-load player (~/lib/markdown-html).
 *
 * The preview here loads nothing from the provider either: a writer pasting a
 * link has not asked to play it. A YouTube preview shows the thumbnail from
 * our own origin.
 */
import {
  type BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";

import { embedLabel, parseEmbed, thumbnailPath } from "~/lib/embeds";

const EmbedBlock = createReactBlockSpec(
  {
    type: "embed",
    propSchema: { url: { default: "" } },
    content: "none",
  },
  {
    render: ({ block }) => <EmbedPreview url={block.props.url} />,
    // The whole point: the export is the bare link, alone on its line.
    toExternalHTML: ({ block }) => (
      <p>
        <a href={block.props.url}>{block.props.url}</a>
      </p>
    ),
  },
);

export function EmbedPreview({ url }: { url: string }) {
  const embed = parseEmbed(url);
  if (!embed) return <p className="text-ink-soft">{url}</p>;
  const { provider, kind } = embedLabel(embed);
  const thumb = thumbnailPath(embed);
  return (
    <div
      className="flex w-full items-center gap-4 border border-rule bg-ink/5 p-3"
      contentEditable={false}
    >
      {thumb ? (
        <img
          alt=""
          className="aspect-video w-28 shrink-0 object-cover"
          src={thumb}
        />
      ) : null}
      <span className="min-w-0 font-display text-sm leading-snug">
        <span className="block font-semibold text-ink">
          {provider} {kind.toLowerCase()}
        </span>
        <span className="block truncate text-xs text-ink-soft">{url}</span>
        <span className="mt-1 block text-xs text-ink-soft">
          {embed.provider === "bluesky"
            ? "Readers see a preview, and the post loads when they open it."
            : "Readers see a preview, and it plays when they press play."}
        </span>
      </span>
    </div>
  );
}

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, embed: EmbedBlock() },
});

export type EditorWithEmbeds = typeof editorSchema.BlockNoteEditor;

type Inline = {
  type?: string;
  text?: string;
  href?: string;
  content?: unknown;
  styles?: Record<string, unknown>;
};

/** The text of a lone unstyled run, or null. */
function plainText(content: unknown): string | null {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const [only] = content as Inline[];
  if (only.type !== "text" || Object.keys(only.styles ?? {}).length > 0)
    return null;
  return only.text?.trim() || null;
}

/**
 * The URL a line holds, if the line is nothing else: a bare link alone on
 * its line. BlockNote parses one as a link whose text is its own URL (before
 * 0.56, as one unstyled run of text), and writes either back as the bare URL.
 * The same rule the renderer applies, so the editor never shows a player the
 * page won't. A URL in code or bold, or a link with words of the writer's
 * choosing, is formatting they chose, and stays as it is.
 */
function soleUrl(content: unknown): string | null {
  const text = plainText(content);
  if (text) return text;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const [only] = content as Inline[];
  if (only.type !== "link") return null;
  const label = plainText(only.content);
  return label && label === only.href ? label : null;
}

/**
 * Blocks parsed from a published post's markdown, with every bare embeddable
 * link alone on its line turned back into an embed block, so reopening a post
 * shows the writer the same previews they pasted. Top level only, like the
 * renderer: a link in a list item stays a link.
 */
export function withEmbedBlocks<T>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const { type, content } = block as { type?: unknown; content?: unknown };
    if (type !== "paragraph") return block;
    const url = soleUrl(content);
    return url && !/\s/.test(url) && parseEmbed(url)
      ? ({ type: "embed", props: { url } } as unknown as T)
      : block;
  });
}

/**
 * Paste: a lone embeddable link on an empty line becomes an embed block, and
 * the cursor moves to a fresh line after it so writing carries on. Anything
 * else (a link mid-sentence, two links, a link with words) pastes as it
 * always did.
 */
export function embedPasteHandler({
  event,
  editor,
  defaultPasteHandler,
}: {
  event: ClipboardEvent;
  editor: BlockNoteEditor<never, never, never>;
  defaultPasteHandler: () => boolean | undefined;
}): boolean | undefined {
  const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
  if (!text || /\s/.test(text) || !parseEmbed(text))
    return defaultPasteHandler();
  const typed = editor as unknown as EditorWithEmbeds;
  const { block } = typed.getTextCursorPosition();
  const empty =
    block.type === "paragraph" &&
    Array.isArray(block.content) &&
    block.content.length === 0;
  if (!empty) return defaultPasteHandler();
  typed.updateBlock(block, { type: "embed", props: { url: text } });
  const [next] = typed.insertBlocks([{ type: "paragraph" }], block, "after");
  typed.setTextCursorPosition(next, "start");
  return true;
}
