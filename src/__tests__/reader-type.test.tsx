/**
 * The reader's text size and typeface: a disclosure in the post's footer that
 * opens two native radio groups, applies each choice to <html> at once,
 * remembers it without cookies, and is put back by the pre-paint bootstrap on
 * the next load.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example/3lyk73wxnok2f" }),
  HeadContent: () => null,
  Scripts: () => null,
}));
vi.mock("@tanstack/react-devtools", () => ({ TanStackDevtools: () => null }));

import { READER_FACE_KEY, READER_SIZE_KEY } from "#/lib/appearance";
import { Route } from "../routes/__root";
import { DocumentArticle } from "./support/document-article";

const root = document.documentElement;

afterEach(() => {
  cleanup();
  delete root.dataset.readerSize;
  delete root.dataset.readerFace;
  localStorage.clear();
});

const doc = {
  title: "Publishing on the open network",
  textContent: "Full body text here.",
  publishedAt: "2026-01-05T00:00:00.000Z",
};

const toggle = () => screen.getByRole("button", { name: "Text options" });

async function openPanel() {
  render(<DocumentArticle doc={doc} ident="writer.example" />);
  fireEvent.click(toggle());
  return {
    size: await screen.findByRole("group", { name: "Text size" }),
    face: screen.getByRole("group", { name: "Typeface" }),
  };
}

describe("Text options", () => {
  it("is a collapsed disclosure until opened", () => {
    render(<DocumentArticle doc={doc} ident="writer.example" />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByRole("group", { name: "Text size" })).toBeNull();
  });

  it("opens a panel the button names, right after it in Tab order", async () => {
    const { size } = await openPanel();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(
      toggle().getAttribute("aria-controls") ?? "",
    );
    expect(panel?.contains(size)).toBe(true);
    // Nothing focusable between the button and the first choice.
    const first = within(size).getAllByRole("radio")[0];
    expect(
      toggle().compareDocumentPosition(first) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(toggle().nextElementSibling).toBe(panel);
  });

  it("offers each choice as a native radio group, starting from the page as published", async () => {
    const { size, face } = await openPanel();
    const sizes = within(size).getAllByRole("radio") as HTMLInputElement[];
    const faces = within(face).getAllByRole("radio") as HTMLInputElement[];
    // One name per group is what gives the browser's arrow-key behaviour.
    expect(new Set(sizes.map((r) => r.name)).size).toBe(1);
    expect(new Set(faces.map((r) => r.name)).size).toBe(1);
    expect(sizes[0].name).not.toBe(faces[0].name);
    expect(
      within(size).getByRole("radio", { name: "Standard" }),
    ).toHaveProperty("checked", true);
    expect(
      within(face).getByRole("radio", { name: "As published" }),
    ).toHaveProperty("checked", true);
  });

  it("applies a size at once and remembers it, and Standard forgets it", async () => {
    const { size } = await openPanel();
    fireEvent.click(within(size).getByRole("radio", { name: "Larger" }));
    expect(root.dataset.readerSize).toBe("larger");
    expect(localStorage.getItem(READER_SIZE_KEY)).toBe("larger");
    expect(within(size).getByRole("radio", { name: "Larger" })).toHaveProperty(
      "checked",
      true,
    );

    fireEvent.click(within(size).getByRole("radio", { name: "Standard" }));
    expect(root.dataset.readerSize).toBeUndefined();
    expect(localStorage.getItem(READER_SIZE_KEY)).toBeNull();
  });

  it("applies and remembers the readable face", async () => {
    const { face } = await openPanel();
    fireEvent.click(
      within(face).getByRole("radio", { name: "Atkinson Hyperlegible" }),
    );
    expect(root.dataset.readerFace).toBe("readable");
    expect(localStorage.getItem(READER_FACE_KEY)).toBe("readable");
  });

  it("opens on what the page is showing", async () => {
    root.dataset.readerSize = "largest";
    root.dataset.readerFace = "readable";
    const { size, face } = await openPanel();
    expect(within(size).getByRole("radio", { name: "Largest" })).toHaveProperty(
      "checked",
      true,
    );
    expect(
      within(face).getByRole("radio", { name: "Atkinson Hyperlegible" }),
    ).toHaveProperty("checked", true);
  });

  it("closes on Escape from inside, handing focus back to the button", async () => {
    const { size } = await openPanel();
    const radio = within(size).getByRole("radio", { name: "Large" });
    radio.focus();
    fireEvent.keyDown(radio, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Text size" })).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape from the button, before focus moves in", async () => {
    await openPanel();
    toggle().focus();
    fireEvent.keyDown(toggle(), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Text size" })).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes from the button too", async () => {
    await openPanel();
    fireEvent.click(toggle());
    expect(screen.queryByRole("group", { name: "Text size" })).toBeNull();
  });

  it("still changes the page when storage refuses", async () => {
    const { size } = await openPanel();
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      fireEvent.click(within(size).getByRole("radio", { name: "Large" }));
      expect(root.dataset.readerSize).toBe("large");
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("the pre-paint bootstrap", () => {
  type Shell = (props: { children: React.ReactNode }) => React.ReactNode;
  const Shell = (Route.options as unknown as { shellComponent: Shell })
    .shellComponent;

  /** Runs the shell's inline script, as the browser does before first paint. */
  function runBootstrap() {
    const html = renderToStaticMarkup(<Shell>{null}</Shell>);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain(READER_SIZE_KEY);
    act(() => {
      new Function(script)();
    });
  }

  it("puts a remembered size and face on <html> before the page renders", () => {
    localStorage.setItem(READER_SIZE_KEY, "larger");
    localStorage.setItem(READER_FACE_KEY, "readable");
    runBootstrap();
    expect(root.dataset.readerSize).toBe("larger");
    expect(root.dataset.readerFace).toBe("readable");
  });

  it("leaves both off for a reader who chose nothing", () => {
    runBootstrap();
    expect(root.dataset.readerSize).toBeUndefined();
    expect(root.dataset.readerFace).toBeUndefined();
  });
});
