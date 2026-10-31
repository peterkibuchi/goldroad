/**
 * The quote offer's chunk can fail to load: a deploy since the page was
 * opened removes the old hashed file, or the connection drops. That must
 * leave the post on screen, not throw to the error page.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Prose } from "../components/prose";

const chunk = vi.hoisted(() => ({ attempts: 0 }));

vi.mock("~/components/passage-share", () => {
  chunk.attempts++;
  throw new Error("Failed to fetch dynamically imported module");
});

afterEach(cleanup);

it("keeps the body on screen when the quote offer fails to load", async () => {
  render(
    <Prose
      html="<p>A line worth keeping.</p>"
      quoteHref={(passage) => `https://bsky.app/intent/compose?text=${passage}`}
    />,
  );
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("A line worth keeping."));
  window.getSelection()?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  // Wait for the import to actually fail, then let its rejection settle,
  // so the body is checked after the failure rather than before it.
  await vi.waitFor(() => expect(chunk.attempts).toBe(1));
  await act(async () => {});
  expect(screen.getByText("A line worth keeping.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /quote on bluesky/i })).toBeNull();
});
