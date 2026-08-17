import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// BlockNote needs a real DOM; the route mounts it lazily behind ClientOnly.
// This stand-in mounts instantly and reports ready, which is all these tests
// need from the editor.
vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  const fakeEditor = { document: [], blocksToMarkdownLossy: () => "body" };
  return {
    default: function FakeEditor({
      onReady,
    }: {
      onReady: (editor: unknown) => void;
    }) {
      useEffect(() => {
        onReady(fakeEditor);
      }, [onReady]);
      return <div data-testid="editor-region" />;
    },
  };
});

import { RECOMMENDED_DEK_LENGTH } from "../lib/publish";
// write.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { Compose } from "../routes/write";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const publishedPost = {
  rkey: "3abc2345678df",
  title: "Hello Atmosphere",
  dek: "",
  markdown: "A body.",
  coverPath: null,
  mirror: null,
};

function subtitle() {
  return screen.getByLabelText("Subtitle") as HTMLTextAreaElement;
}

describe("/write — the title is one wrapping line, not a text input", () => {
  it("moves to the subtitle on Enter instead of breaking the line", () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    const title = screen.getByLabelText("Title") as HTMLTextAreaElement;
    // A textarea so a long title wraps the way the published page wraps it.
    expect(title.tagName).toBe("TEXTAREA");
    expect(title.required).toBe(true);

    fireEvent.change(title, { target: { value: "A title" } });
    const event = fireEvent.keyDown(title, { key: "Enter" });
    expect(event).toBe(false); // preventDefault: no newline in a title
    expect(document.activeElement).toBe(screen.getByLabelText("Subtitle"));
  });
});

describe("/write — the subtitle field", () => {
  it("sits in the publish form, so it travels with the post", () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    const field = subtitle();
    expect(field.name).toBe("dek");
    expect(field.value).toBe("");
    expect(document.getElementById("publish-form")?.contains(field)).toBe(true);
  });

  it("opens an edit with the subtitle the writer wrote", () => {
    render(
      <Compose
        draft={{ ...publishedPost, dek: "What this one is about" }}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    expect(subtitle().value).toBe("What this one is about");
  });

  it("opens a resumed draft with its saved subtitle", () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={{
          id: "11111111-2222-4333-8444-555555555555",
          title: "Draft title",
          dek: "Saved subtitle",
          blocksJson: "[]",
          markdown: "",
          inlineImages: "",
          imported: false,
          schedule: null,
        }}
      />,
    );
    expect(subtitle().value).toBe("Saved subtitle");
  });

  it("guides on length without refusing it — a long line still submits", () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    const field = subtitle();
    expect(screen.getByText(/a sentence or two/i)).toBeTruthy();

    const long = "x".repeat(RECOMMENDED_DEK_LENGTH + 12);
    fireEvent.change(field, { target: { value: long } });
    // The note states what happens (trimming), and the field keeps the words.
    expect(screen.getByText(/characters/).textContent).toContain(
      String(long.length),
    );
    expect(field.value).toBe(long);
    expect(field.hasAttribute("required")).toBe(false);
  });
});
