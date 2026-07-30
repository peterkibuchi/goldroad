import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// dashboard.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import type { DashboardRow } from "../lib/dashboard";
import type { DocumentEngagement } from "../lib/engagement";
import { PostsManager } from "../routes/dashboard";
import { VIEWS_OFF, viewsEnvelope } from "./support/views-envelope";

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

function stubStatsFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function renderManager(
  rows: DashboardRow[],
  engagement = new Map<string, DocumentEngagement>(),
) {
  return render(
    <PostsManager
      drafts={[]}
      engagement={engagement}
      ident={IDENT}
      nextCursor={null}
      onTabChange={() => {}}
      rows={rows}
      tab="published"
    />,
  );
}

/**
 * The stats seam feeds the manager's inline per-post metrics. All three of its
 * non-ready states must render the same thing on a row: nothing. A "0 views"
 * would tell a writer their post went unread — a claim cookieless analytics
 * can never make.
 */
describe("posts manager metrics — stats seam not configured", () => {
  it("renders the row but no view count at all", async () => {
    stubStatsFetch(VIEWS_OFF);
    renderManager([row("3aaa2aaa2aaa2", "a post")]);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByText("a post");
    expect(screen.queryByText(/^\d+ views?$/)).toBeNull();
  });

  it("offers no most-read sort when there is nothing to sort by", async () => {
    stubStatsFetch(VIEWS_OFF);
    renderManager([row("3aaa2aaa2aaa2", "a post")]);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("option", { name: /most read/i })).toBeNull();
  });
});

describe("posts manager metrics — stats seam answering", () => {
  it("shows a view count only on the rows the provider actually recorded", async () => {
    stubStatsFetch(
      viewsEnvelope({
        status: "ok",
        total: 35,
        paths: [
          { path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 30 },
          { path: `/@${IDENT}`, views: 5 },
        ],
      }),
    );
    renderManager([
      row("3aaa2aaa2aaa2", "the recorded post"),
      row("3bbb2bbb2bbb2", "the unrecorded post"),
    ]);

    await screen.findByText("30 views");
    // Both rows are listed; only one carries a number. Absence isn't zero.
    screen.getByText("the unrecorded post");
    expect(screen.queryByText("0 views")).toBeNull();
    expect(screen.getAllByText(/^\d+ views?$/)).toHaveLength(1);
  });

  it("uses the singular for a single view", async () => {
    stubStatsFetch(
      viewsEnvelope({
        status: "ok",
        total: 1,
        paths: [{ path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 1 }],
      }),
    );
    renderManager([row("3aaa2aaa2aaa2", "a post")]);
    await screen.findByText("1 view");
  });

  it("offers the most-read sort once counts exist", async () => {
    stubStatsFetch(
      viewsEnvelope({
        status: "ok",
        total: 30,
        paths: [{ path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 30 }],
      }),
    );
    renderManager([row("3aaa2aaa2aaa2", "a post")]);
    await screen.findByRole("option", { name: /most read/i });
  });
});

describe("posts manager metrics — stats seam unavailable", () => {
  it("renders no numbers, and the list still works", async () => {
    stubStatsFetch(viewsEnvelope({ status: "unavailable" }));
    renderManager([row("3aaa2aaa2aaa2", "a post")]);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByText("a post");
    expect(screen.queryByText(/^\d+ views?$/)).toBeNull();
  });

  it("degrades the same way on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    renderManager([row("3aaa2aaa2aaa2", "a post")]);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByText("a post");
    expect(screen.queryByText(/^\d+ views?$/)).toBeNull();
  });
});

/**
 * Cross-network counts come from the announcement's Bluesky post, independent
 * of the analytics seam — including their own absence rules.
 */
describe("posts manager metrics — cross-network counts", () => {
  const threadUrl = "https://bsky.app/profile/writer.example/post/abc123";

  it("renders the counted metrics and links the reply count to the thread", async () => {
    stubStatsFetch(VIEWS_OFF);
    renderManager(
      [row("3aaa2aaa2aaa2", "an announced post")],
      new Map([
        [
          "3aaa2aaa2aaa2",
          {
            counts: { likeCount: 12, replyCount: 3, repostCount: 4 },
            threadUrl,
          },
        ],
      ]),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByText("12");
    screen.getByText("4");
    const reply = screen.getByTitle("View the replies on Bluesky");
    expect(reply.getAttribute("href")).toBe(threadUrl);
  });

  it("skips a metric the AppView left uncounted rather than showing zero", async () => {
    stubStatsFetch(VIEWS_OFF);
    renderManager(
      [row("3aaa2aaa2aaa2", "an announced post")],
      new Map([["3aaa2aaa2aaa2", { counts: { likeCount: 7 }, threadUrl }]]),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByText("7");
    expect(screen.queryByTitle("View the replies on Bluesky")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("renders nothing for an announced post whose every count came back uncounted", async () => {
    stubStatsFetch(VIEWS_OFF);
    renderManager(
      [row("3aaa2aaa2aaa2", "an announced post")],
      new Map([["3aaa2aaa2aaa2", { counts: {}, threadUrl }]]),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByText("an announced post");
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByTitle("View the replies on Bluesky")).toBeNull();
  });
});
