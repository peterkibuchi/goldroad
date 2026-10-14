import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What /write says about an imported draft's pictures before Publish: how many
 * still load from the source, how many one publish can copy, and nothing about
 * blank images on a thread draft, whose pictures already show.
 */

const editorDoc = vi.hoisted(() => ({ blocks: [] as unknown[] }));
const changed = vi.hoisted(() => ({ fire: () => {} }));

// BlockNote needs a real DOM; this stand-in reports ready and exposes a
// document the test controls, and its onChange is fired by hand.
vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  const fakeEditor = {
    get document() {
      return editorDoc.blocks;
    },
    blocksToMarkdownLossy: () => "body",
  };
  return {
    default: function FakeEditor({
      onReady,
      onChange,
    }: {
      onReady: (editor: unknown) => void;
      onChange: () => void;
    }) {
      useEffect(() => {
        onReady(fakeEditor);
        changed.fire = onChange;
      }, [onReady, onChange]);
      return <div data-testid="editor-region" />;
    },
  };
});

import { MAX_REHOSTED_IMAGES } from "../lib/import";
import { Compose } from "../routes/write";

afterEach(cleanup);

const image = (url: string) => ({
  type: "image",
  props: { url, name: "alt" },
  children: [],
});

function resumed(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    title: "Imported",
    dek: "",
    blocksJson: "[]",
    markdown: "",
    inlineImages: "",
    imported: true,
    fromThread: false,
    copyLimit: MAX_REHOSTED_IMAGES,
    schedule: null,
    ...over,
  };
}

/** The route lazy-loads the editor, so wait for it before driving it. */
async function mount(draft: ReturnType<typeof resumed>) {
  render(
    <Compose
      draft={null}
      error={undefined}
      reconnectHandle={null}
      resumed={draft}
    />,
  );
  await screen.findByTestId("editor-region");
}

describe("/write — an imported draft's pictures", () => {
  it("says when one publish can't copy every remote image", async () => {
    editorDoc.blocks = Array.from({ length: MAX_REHOSTED_IMAGES + 2 }, (_, i) =>
      image(`https://cdn.example/${i}.jpg`),
    );
    await mount(resumed());
    await waitFor(() => {
      act(() => changed.fire());
      expect(
        screen.getByText(
          new RegExp(`One publish copies up to ${MAX_REHOSTED_IMAGES};`),
        ),
      ).toBeDefined();
    });
  });

  it("doesn't mention the limit when everything fits", async () => {
    editorDoc.blocks = [image("https://cdn.example/1.jpg")];
    await mount(resumed());
    await waitFor(() => {
      act(() => changed.fire());
      expect(screen.getByText(/one image still hosted/i)).toBeDefined();
    });
    expect(screen.queryByText(/One publish copies up to/)).toBeNull();
  });

  it("doesn't call a thread draft's pictures blank — they already show", async () => {
    editorDoc.blocks = [];
    const blocks = JSON.stringify([image("/img/did%3Aplc%3Ax/bafkreiabc")]);
    await mount(resumed({ blocksJson: blocks, fromThread: true }));
    expect(screen.queryByText(/stay\s+blank here/i)).toBeNull();
  });

  it("still warns about blank images on any other resumed draft", async () => {
    editorDoc.blocks = [];
    const blocks = JSON.stringify([image("/img/did%3Aplc%3Ax/bafkreiabc")]);
    await mount(resumed({ blocksJson: blocks, imported: false }));
    expect(screen.getByText(/stay\s+blank here/i)).toBeDefined();
  });
});
