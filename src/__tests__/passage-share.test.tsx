/**
 * Quoting a selected passage: the offer loads on the first selection inside
 * the body, quotes only what the writer wrote, and follows the keyboard rules
 * its header promises (reachable by Tab after the body, Escape to dismiss).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { passageShareUrl } from "#/lib/bluesky-share";
import { Prose } from "../components/prose";

// jsdom lays nothing out, so a range has no line boxes; browsers always do.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

const URL_ = "https://trygoldroad.com/@writer.example/3lyk73wxnok2f";
const HTML =
  '<p>First paragraph, with <a href="https://example.com">a link</a>.</p><p>A line worth keeping.</p>';

function renderPage() {
  return render(
    <>
      <p data-testid="byline">@writer.example</p>
      <Prose
        html={HTML}
        quoteHref={(passage) => passageShareUrl(passage, URL_)}
      />
      <a href="/next">After the body</a>
    </>,
  );
}

/** Selects the whole text of `node`, as a reader dragging across it would,
 * and lets the document announce it. */
async function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

const offer = () => screen.queryByRole("link", { name: /quote on bluesky/i });

describe("PassageShare", () => {
  it("offers nothing until the reader selects something", () => {
    renderPage();
    expect(offer()).toBeNull();
  });

  it("loads on a selection in the body and quotes it with the post's link", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    const link = await screen.findByRole("link", { name: /quote on bluesky/i });
    const text = new URL(link.getAttribute("href") ?? "").searchParams.get(
      "text",
    );
    expect(text).toBe(`“A line worth keeping.”\n\n${URL_}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("ignores a selection outside the body", async () => {
    renderPage();
    await select(screen.getByTestId("byline"));
    expect(offer()).toBeNull();
  });

  it("puts the offer away when the selection collapses", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    await screen.findByRole("link", { name: /quote on bluesky/i });
    window.getSelection()?.collapseToEnd();
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(offer()).toBeNull();
  });

  it("comes after the body's own links in Tab order", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    const link = await screen.findByRole("link", { name: /quote on bluesky/i });
    const bodyLink = screen.getByRole("link", { name: "a link" });
    const after = screen.getByRole("link", { name: "After the body" });
    // Neither link sets tabIndex, so DOM order is Tab order.
    expect(link.hasAttribute("tabindex")).toBe(false);
    expect(
      bodyLink.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      link.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("is dismissed by Escape, from the page or from the link, and keeps the selection", async () => {
    renderPage();
    const passage = screen.getByText("A line worth keeping.");
    await select(passage);
    let link = await screen.findByRole("link", { name: /quote on bluesky/i });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(offer()).toBeNull();
    expect(window.getSelection()?.toString()).toBe("A line worth keeping.");

    await select(passage);
    link = await screen.findByRole("link", { name: /quote on bluesky/i });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(offer()).toBeNull();
    expect(document.activeElement).not.toBe(link);
  });

  it("stays while focused, so Tab can reach it", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    const link = await screen.findByRole("link", { name: /quote on bluesky/i });
    link.focus();
    window.getSelection()?.collapseToEnd();
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(offer()).toBe(link);
  });

  it("survives a press on the link, which is not the start of a new drag", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    const link = await screen.findByRole("link", { name: /quote on bluesky/i });
    fireEvent.pointerDown(link, { buttons: 1, pointerType: "mouse" });
    expect(offer()).toBe(link);
  });

  it("hides while the mouse drags out a selection, and returns on release", async () => {
    renderPage();
    const passage = screen.getByText("A line worth keeping.");
    await select(passage);
    await screen.findByRole("link", { name: /quote on bluesky/i });
    fireEvent.pointerDown(passage, { buttons: 1, pointerType: "mouse" });
    expect(offer()).toBeNull();
    fireEvent.pointerUp(passage, { buttons: 0, pointerType: "mouse" });
    expect(offer()).not.toBeNull();
  });

  it("ignores touch presses, whose selection gestures end in pointercancel", async () => {
    renderPage();
    const passage = screen.getByText("A line worth keeping.");
    await select(passage);
    await screen.findByRole("link", { name: /quote on bluesky/i });
    fireEvent.pointerDown(passage, { buttons: 1, pointerType: "touch" });
    fireEvent.pointerCancel(passage, { pointerType: "touch" });
    await select(passage);
    expect(offer()).not.toBeNull();
  });

  it("leaves an Escape that something else already handled alone", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    await screen.findByRole("link", { name: /quote on bluesky/i });
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    fireEvent(document.body, handled);
    expect(offer()).not.toBeNull();
  });

  it("keeps the selection when the link is pressed", async () => {
    renderPage();
    await select(screen.getByText("A line worth keeping."));
    const link = await screen.findByRole("link", { name: /quote on bluesky/i });
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.mouseDown(link)).toBe(false);
  });

  it("offers nothing on a body without a share address", async () => {
    render(<Prose html={HTML} />);
    await select(screen.getByText("A line worth keeping."));
    expect(offer()).toBeNull();
  });
});
