import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// dashboard.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import type { DashboardRow } from "../lib/dashboard";
import { PostsManager } from "../routes/dashboard";
import { viewsEnvelope } from "./support/views-envelope";

/**
 * Where the Posts page stops and analytics begins.
 *
 * Posts is a work surface: every element is an affordance for acting on a
 * specific post. It used to end with a "Readers" strip — a total, a flat list
 * of per-post counts, an honesty line — and that depth moved to /stats, which
 * is built for the open question. What stayed is the per-row count, which
 * belongs to the row it annotates.
 *
 * Two rules survive that move, and both are about a writer's ability to work:
 *
 *  1. Analytics NEVER gates the page. The stats read happens after mount, in
 *     its own request; the posts and their actions render from the loader data
 *     the page already has. An upstream that hangs forever costs a writer a
 *     view count, never the Delete button.
 *  2. No aggregate lands here. A total is the question /stats answers.
 *
 * These are behavioural on purpose. The suite this replaced asserted an
 * absent export name and grepped the route source for "/api/stats" — both
 * pass forever, including after the strip is fully restored under another
 * name or through another module.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IDENT = "writer.example";

function row(rkey: string, title: string): DashboardRow {
  return {
    rkey,
    title,
    description: null,
    publishedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: null,
    coverPath: null,
    readingMinutes: 0,
    editable: true,
    announced: null,
  };
}

function renderManager(rows: DashboardRow[]) {
  render(
    <PostsManager
      drafts={[]}
      engagement={new Map()}
      ident={IDENT}
      nextCursor={null}
      onTabChange={() => {}}
      scheduled={[]}
      rows={rows}
      tab="published"
    />,
  );
}

describe("the Posts page never waits on analytics", () => {
  it("renders every post and its actions while the stats request hangs", () => {
    // Never settles — the worst an upstream can do short of being down.
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", hanging);

    renderManager([
      row("3aaa2aaa2aaa2", "the first post"),
      row("3bbb2bbb2bbb2", "the second post"),
    ]);

    // Synchronous: no waitFor, because nothing here is allowed to await the
    // analytics answer. Both posts, both editable, both deletable.
    screen.getByText("the first post");
    screen.getByText("the second post");
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Edit" })).toHaveLength(2);

    // And no number is invented in the meantime — a pending read is not a zero.
    expect(screen.queryByText(/\d+ views?/)).toBeNull();
  });
});

describe("the Posts page carries no aggregate", () => {
  it("annotates the row it has a count for and states no total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              viewsEnvelope({
                status: "ok",
                // A total the rows cannot account for: 30 on the one post
                // shown, 47 across the writer's whole site. If a Readers strip
                // ever returns, 47 is what it would print.
                total: 47,
                paths: [
                  { path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 30 },
                  { path: `/@${IDENT}`, views: 17 },
                ],
              }),
            ),
            { status: 200 },
          ),
      ),
    );

    renderManager([row("3aaa2aaa2aaa2", "the recorded post")]);

    // The per-row count arrives — proof the seam is live, not merely silent.
    await screen.findByText("30 views");
    expect(screen.queryByText(/47/)).toBeNull();
    expect(screen.queryByText(/readers/i)).toBeNull();
    // The writer's own landing-page views are site-level, not a post's.
    expect(screen.queryByText(/17/)).toBeNull();
  });
});
