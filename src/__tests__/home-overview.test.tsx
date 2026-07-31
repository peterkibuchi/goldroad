import { isRedirect } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// home.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import type { DashboardRow, DraftRow } from "../lib/dashboard";
import { Overview, requireOverview } from "../routes/home";
import {
  VIEWS_OFF,
  VIEWS_UNAVAILABLE,
  viewsReady,
} from "./support/views-envelope";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IDENT = "writer.example";

function stubStats(body: unknown = VIEWS_OFF) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

function post(rkey: string, title: string): DashboardRow {
  return {
    rkey,
    title,
    description: null,
    publishedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: null,
    coverPath: null,
    readingMinutes: 4,
    editable: true,
    announced: null,
  };
}

function draft(id: string, title: string): DraftRow {
  return {
    id,
    title,
    updatedAt: "2026-07-10T00:00:00.000Z",
    description: null,
  };
}

const LATEST = post("3ccc2ccc2ccc2", "The most recent piece");

function renderOverview(
  overrides: Partial<React.ComponentProps<typeof Overview>> = {},
) {
  const props: React.ComponentProps<typeof Overview> = {
    ident: IDENT,
    publicationName: "Field Notes",
    iconPath: null,
    published: { count: 3, countComplete: true, latest: LATEST },
    engagement: null,
    drafts: [],
    ...overrides,
  };
  return render(<Overview {...props} />);
}

/**
 * The overview is the signed-in landing surface, so an anonymous arrival is a
 * redirect to the sign-in form — never an error page and never a stripped-down
 * "signed out" variant of a writer's own cockpit.
 */
describe("overview — landing contract", () => {
  it("redirects to the sign-in form when there is no session", () => {
    let thrown: unknown;
    try {
      requireOverview(null);
    } catch (err) {
      thrown = err;
    }
    expect(isRedirect(thrown)).toBe(true);
    // A router redirect is a Response carrying its navigation options.
    const options = (
      thrown as { options: { to?: string; search?: { returnTo?: string } } }
    ).options;
    expect(options.to).toBe("/write");
    // …and it names this page as the destination, so signing in comes back to
    // the overview instead of stranding the writer in the editor that happens
    // to host the sign-in form.
    expect(options.search?.returnTo).toBe("/home");
  });

  it("passes the writer's own data straight through", () => {
    const data = { ident: IDENT };
    expect(requireOverview(data)).toBe(data);
  });
});

describe("overview — identity line", () => {
  it("leads with the publication's own name, not a greeting", () => {
    stubStats();
    renderOverview();
    expect(
      screen.getByRole("heading", { level: 1, name: "Field Notes" }),
    ).toBeDefined();
    expect(screen.queryByText(/welcome|good morning|hello/i)).toBeNull();
  });

  it("falls back to the handle before the first publication record exists", () => {
    stubStats();
    renderOverview({ publicationName: null });
    expect(
      screen.getByRole("heading", { level: 1, name: `@${IDENT}` }),
    ).toBeDefined();
  });

  it("links to the writer's public publication", () => {
    stubStats();
    renderOverview();
    expect(
      screen
        .getByRole("link", { name: /view your publication/i })
        .getAttribute("href"),
    ).toBe(`/@${IDENT}`);
  });
});

/**
 * The adaptive next action is the page's one primary button. It has to name
 * the actual next move: resume the unfinished thing when there is one.
 */
describe("overview — the adaptive primary action", () => {
  it("invites a start when there is no unfinished work", () => {
    stubStats();
    renderOverview({ drafts: [] });
    const start = screen.getByRole("link", { name: "Start writing" });
    expect(start.getAttribute("href")).toBe("/write");
    expect(screen.queryByRole("link", { name: /^Resume "/ })).toBeNull();
  });

  it("names the draft to resume, and links straight into it", () => {
    stubStats();
    renderOverview({ drafts: [draft("d1", "Half-written thing")] });
    const resume = screen.getByRole("link", {
      name: 'Resume "Half-written thing"',
    });
    expect(resume.getAttribute("href")).toBe("/write?draft=d1");
    expect(screen.queryByRole("link", { name: "Start writing" })).toBeNull();
  });

  it("still gives an untitled draft something to be called", () => {
    stubStats();
    renderOverview({ drafts: [draft("d1", "   ")] });
    screen.getByRole("link", { name: 'Resume "(untitled draft)"' });
  });

  it("resumes the most recently edited draft, which is the first one", () => {
    stubStats();
    renderOverview({
      drafts: [draft("d1", "Most recent"), draft("d2", "Older")],
    });
    // The shortlist below also offers "Resume" links; this is the primary one,
    // which names the draft it will open.
    expect(
      screen
        .getByRole("link", { name: 'Resume "Most recent"' })
        .getAttribute("href"),
    ).toBe("/write?draft=d1");
  });
});

/**
 * The headline numbers exist only when the analytics seam does. Anything else
 * would be a cockpit of invented instruments.
 */
describe("overview — headline numbers", () => {
  it("omits the whole block when the seam isn't configured — no teaser", async () => {
    stubStats(VIEWS_OFF);
    renderOverview();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Your numbers")).toBeNull();
    expect(screen.queryByText(/all-time views/i)).toBeNull();
  });

  it("omits it when the seam is configured but couldn't answer", async () => {
    stubStats(VIEWS_UNAVAILABLE);
    renderOverview();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Your numbers")).toBeNull();
  });

  it("shows views, posts and drafts once the seam answers", async () => {
    stubStats(viewsReady(120));
    renderOverview({ drafts: [draft("d1", "One draft")] });
    await screen.findByLabelText("Your numbers");
    screen.getByText(/all-time views/i);
    screen.getByText(/posts published/i);
    screen.getByText(/drafts in progress/i);
    screen.getByText("3");
    screen.getByText("1");
  });

  it("marks the post count as a floor when more pages exist behind it", async () => {
    stubStats(viewsReady(120));
    renderOverview({
      published: { count: 50, countComplete: false, latest: LATEST },
    });
    await screen.findByLabelText("Your numbers");
    screen.getByText("50+");
    screen.getByText(/covers the most recent/i);
  });

  it("drops the post count entirely — not to zero — when the read flaked", async () => {
    stubStats(viewsReady(120));
    renderOverview({ published: null });
    await screen.findByLabelText("Your numbers");
    expect(screen.queryByText(/posts published/i)).toBeNull();
  });

  it("drops the draft count entirely when the drafts read flaked", async () => {
    stubStats(viewsReady(120));
    renderOverview({ drafts: null });
    await screen.findByLabelText("Your numbers");
    expect(screen.queryByText(/drafts in progress/i)).toBeNull();
  });
});

describe("overview — the most recent post", () => {
  it("shows the piece with its date and reading time", () => {
    stubStats();
    renderOverview();
    screen.getByText("Published most recently");
    const title = screen.getByRole("link", { name: "The most recent piece" });
    expect(title.getAttribute("href")).toBe(`/@${IDENT}/3ccc2ccc2ccc2`);
    screen.getByText(/4 min read/);
  });

  it("carries a view count only when the seam recorded that exact post", async () => {
    stubStats(
      viewsReady(90, [{ path: `/@${IDENT}/3ccc2ccc2ccc2`, views: 90 }]),
    );
    renderOverview();
    await screen.findByText("90 views");
  });

  it("shows no view count for a post the seam never recorded", async () => {
    stubStats(
      viewsReady(90, [{ path: `/@${IDENT}/some-other-post`, views: 90 }]),
    );
    renderOverview();
    await screen.findByLabelText("Your numbers");
    // The block's own "All-time views" label is not a per-post count.
    expect(screen.queryByText(/^\d+ views?$/)).toBeNull();
    expect(screen.queryByText("0 views")).toBeNull();
  });

  it("shows cross-network counts when the post was announced", () => {
    stubStats();
    renderOverview({
      engagement: {
        counts: { likeCount: 9 },
        threadUrl: "https://bsky.app/profile/writer.example/post/abc",
      },
    });
    screen.getByText("9");
  });

  it("renders no recent-post block at all before the first publish", () => {
    stubStats();
    renderOverview({
      published: { count: 0, countComplete: true, latest: null },
    });
    expect(screen.queryByText("Published most recently")).toBeNull();
  });
});

describe("overview — drafts shortlist", () => {
  it("lists up to three, each resumable", () => {
    stubStats();
    renderOverview({
      drafts: [draft("d1", "One"), draft("d2", "Two"), draft("d3", "Three")],
    });
    screen.getByText(/in progress/i);
    expect(screen.getAllByRole("link", { name: "Resume" })).toHaveLength(3);
  });

  it("hands off to the manager's drafts tab rather than growing the list", () => {
    stubStats();
    renderOverview({
      drafts: [
        draft("d1", "One"),
        draft("d2", "Two"),
        draft("d3", "Three"),
        draft("d4", "Four"),
      ],
    });
    expect(screen.getAllByRole("link", { name: "Resume" })).toHaveLength(3);
    expect(
      screen.getByRole("link", { name: /all 4 drafts/i }).getAttribute("href"),
    ).toBe("/dashboard?tab=drafts");
  });

  it("renders no shortlist when there are no drafts", () => {
    stubStats();
    renderOverview({ drafts: [] });
    expect(screen.queryByText(/in progress/i)).toBeNull();
  });
});

describe("overview — first run and failures", () => {
  it("teaches the first step when nothing has been written yet", () => {
    stubStats();
    renderOverview({
      published: { count: 0, countComplete: true, latest: null },
      drafts: [],
    });
    screen.getByRole("heading", { name: /starts with one post/i });
    screen.getByRole("link", { name: "Start writing" });
  });

  it("says a failed posts read failed instead of showing a blank publication", () => {
    stubStats();
    renderOverview({ published: null });
    screen.getByText(/couldn't be loaded right now/i);
    expect(
      screen.queryByRole("heading", { name: /starts with one post/i }),
    ).toBeNull();
  });

  it("says a failed drafts read failed", () => {
    stubStats();
    renderOverview({ drafts: null });
    screen.getByText(/drafts couldn't be loaded right now/i);
  });
});
