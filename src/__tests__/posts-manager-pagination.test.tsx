import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardRow } from "../lib/dashboard";
import { PostsManager } from "../routes/dashboard";
import { TestRouter } from "./support/router";
import { VIEWS_OFF } from "./support/views-envelope";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IDENT = "writer.example";

function post(rkey: string, title: string, publishedAt: string): DashboardRow {
  return {
    rkey,
    title,
    description: null,
    publishedAt,
    updatedAt: null,
    coverPath: null,
    readingMinutes: 0,
    editable: true,
    announced: null,
  };
}

const POSTS = [
  post("3aaa2aaa2aaa2", "Zebra crossing", "2026-07-01T00:00:00.000Z"),
  post("3bbb2bbb2bbb2", "Anchor essay", "2026-06-01T00:00:00.000Z"),
];

function renderManager() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(VIEWS_OFF), { status: 200 })),
  );
  return render(
    <TestRouter path="/dashboard">
      <PostsManager
        cursor={undefined}
        drafts={[]}
        engagement={new Map()}
        ident={IDENT}
        nextCursor="cursor-abc"
        onTabChange={() => {}}
        rows={POSTS}
        scheduled={[]}
        tab="published"
      />
    </TestRouter>,
  );
}

/**
 * "Older posts →" points at /dashboard — the page it is already on. As a plain
 * anchor that is a full document load: the server re-renders the route and the
 * browser throws away the manager, taking the search box and the sort with it.
 * The writer asked for the next page of posts and got their filters reset.
 */
describe("posts manager — turning the page keeps the page", () => {
  it("handles the click itself instead of letting the browser reload", () => {
    renderManager();
    const older = screen.getByRole("link", { name: /older posts/i });
    // fireEvent returns false when the handler called preventDefault, which is
    // how a router link says "I am navigating, don't unload the document".
    // A plain <a href> lets it through and the browser takes over.
    expect(fireEvent.click(older, { button: 0 })).toBe(false);
  });

  it("still resolves to a real address for a middle-click or a crawler", () => {
    renderManager();
    expect(
      screen.getByRole("link", { name: /older posts/i }).getAttribute("href"),
    ).toBe("/dashboard?cursor=cursor-abc");
  });
});
