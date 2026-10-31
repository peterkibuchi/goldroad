/**
 * The type panel's chunk can fail to load: a deploy since the page was opened
 * removes the old hashed file, or the connection drops. That must leave the
 * post on screen with the control shut, not throw to the error page.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example/3lyk73wxnok2f" }),
}));
vi.mock("~/components/reader-type-panel", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

import { DocumentArticle } from "./support/document-article";

afterEach(cleanup);

it("keeps the post and a shut control when the panel fails to load", async () => {
  render(
    <DocumentArticle
      doc={{ title: "Still here", textContent: "The body stays." }}
      ident="writer.example"
    />,
  );
  const toggle = screen.getByRole("button", { name: "Text options" });
  await act(async () => {
    fireEvent.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(screen.getByText("The body stays.")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("group", { name: "Text size" })).toBeNull();
});
