import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// dashboard.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import type { DashboardRow, DraftRow, PostsTab } from "../lib/dashboard";
import type { DocumentEngagement } from "../lib/engagement";
import { PostsManager } from "../routes/dashboard";
import { VIEWS_OFF, viewsReady } from "./support/views-envelope";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IDENT = "writer.example";

/** The manager reads /api/stats on mount; every test here is about the table,
 * so the seam stays off unless a test says otherwise. */
function stubStats(body: unknown = VIEWS_OFF) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

function post(
  rkey: string,
  title: string,
  publishedAt: string | null,
  description: string | null = null,
): DashboardRow {
  return {
    rkey,
    title,
    description,
    publishedAt,
    updatedAt: null,
    coverPath: null,
    readingMinutes: 0,
    editable: true,
    announced: null,
  };
}

function draft(id: string, title: string, updatedAt: string): DraftRow {
  return { id, title, updatedAt, description: null };
}

// Newest first, the order the loader hands them over in.
const POSTS = [
  post("3ccc2ccc2ccc2", "Zebra crossing", "2026-07-01T00:00:00.000Z"),
  post(
    "3bbb2bbb2bbb2",
    "Middle piece",
    "2026-03-01T00:00:00.000Z",
    "about zebras",
  ),
  post("3aaa2aaa2aaa2", "Anchor essay", "2026-01-01T00:00:00.000Z"),
];

const DRAFTS = [
  draft("d1", "Draft about zebras", "2026-07-10T00:00:00.000Z"),
  draft("d2", "Older draft", "2026-05-10T00:00:00.000Z"),
];

function renderManager(
  overrides: Partial<React.ComponentProps<typeof PostsManager>> = {},
) {
  const props: React.ComponentProps<typeof PostsManager> = {
    ident: IDENT,
    rows: POSTS,
    engagement: new Map<string, DocumentEngagement>(),
    drafts: DRAFTS,
    nextCursor: null,
    tab: "published",
    onTabChange: () => {},
    ...overrides,
  };
  return render(<PostsManager {...props} />);
}

/** Titles of the currently visible post/draft rows, in DOM order. */
function visibleTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((li) => li.querySelector("a")?.textContent?.trim() ?? "")
    .filter(Boolean);
}

describe("posts manager — tabs", () => {
  it("offers exactly two tabs: there is no scheduled publishing to tab into", () => {
    stubStats();
    renderManager();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain("Published");
    expect(tabs[1]).toContain("Drafts");
    expect(screen.queryByRole("tab", { name: /scheduled/i })).toBeNull();
  });

  it("shows the published panel and hides the drafts panel", () => {
    stubStats();
    renderManager();
    expect(
      screen
        .getByRole("tab", { name: /published/i })
        .getAttribute("aria-selected"),
    ).toBe("true");
    screen.getByText("Zebra crossing");
    // The drafts panel is present but hidden, so its rows aren't offered.
    const draftsPanel = document.getElementById("panel-drafts");
    expect(draftsPanel?.hasAttribute("hidden")).toBe(true);
  });

  it("switches panels when the tab is changed", () => {
    stubStats();
    let tab: PostsTab = "published";
    const { rerender } = render(
      <PostsManager
        drafts={DRAFTS}
        engagement={new Map()}
        ident={IDENT}
        nextCursor={null}
        onTabChange={(next) => {
          tab = next;
        }}
        rows={POSTS}
        tab={tab}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /drafts/i }));
    expect(tab).toBe("drafts");

    rerender(
      <PostsManager
        drafts={DRAFTS}
        engagement={new Map()}
        ident={IDENT}
        nextCursor={null}
        onTabChange={() => {}}
        rows={POSTS}
        tab={tab}
      />,
    );
    expect(
      document.getElementById("panel-drafts")?.hasAttribute("hidden"),
    ).toBe(false);
    expect(
      document.getElementById("panel-published")?.hasAttribute("hidden"),
    ).toBe(true);
    screen.getByText("Draft about zebras");
  });

  it("counts drafts on the tab, and published posts only when the count is the whole truth", () => {
    stubStats();
    const { unmount } = renderManager();
    expect(
      screen.getByRole("tab", { name: /published/i }).textContent,
    ).toContain("3");
    expect(screen.getByRole("tab", { name: /drafts/i }).textContent).toContain(
      "2",
    );
    unmount();

    // Paginated: the loaded page isn't the archive, so no count is claimed.
    cleanup();
    renderManager({ nextCursor: "cursor-abc" });
    expect(
      screen.getByRole("tab", { name: /published/i }).textContent,
    ).not.toContain("3");
  });
});

describe("posts manager — search", () => {
  it("filters the published list by title", () => {
    stubStats();
    renderManager();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "anchor" },
    });
    expect(visibleTitles()).toEqual(["Anchor essay"]);
  });

  it("matches the dek as well as the title", () => {
    stubStats();
    renderManager();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zebra" },
    });
    // "Zebra crossing" by title, "Middle piece" by its dek.
    expect(visibleTitles().sort()).toEqual(["Middle piece", "Zebra crossing"]);
  });

  it("says so, in the query's own words, when nothing matches", () => {
    stubStats();
    renderManager();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "nothing here" },
    });
    screen.getByText(/no posts on this page match "nothing here"/i);
  });

  it("carries the same query across to the drafts tab", () => {
    stubStats();
    const { rerender } = renderManager();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zebra" },
    });
    rerender(
      <PostsManager
        drafts={DRAFTS}
        engagement={new Map()}
        ident={IDENT}
        nextCursor={null}
        onTabChange={() => {}}
        rows={POSTS}
        tab="drafts"
      />,
    );
    expect(visibleTitles()).toEqual(["Draft about zebras"]);
  });
});

describe("posts manager — sort", () => {
  it("starts newest first", () => {
    stubStats();
    renderManager();
    expect(visibleTitles()).toEqual([
      "Zebra crossing",
      "Middle piece",
      "Anchor essay",
    ]);
  });

  it("reverses to oldest first", () => {
    stubStats();
    renderManager();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "oldest" },
    });
    expect(visibleTitles()).toEqual([
      "Anchor essay",
      "Middle piece",
      "Zebra crossing",
    ]);
  });

  it("parks posts with no recorded views at the end of a most-read sort, not at zero", async () => {
    stubStats(
      viewsReady(40, [
        { path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 40 },
        { path: `/@${IDENT}/3bbb2bbb2bbb2`, views: 2 },
      ]),
    );
    renderManager();
    await screen.findByRole("option", { name: /most read/i });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "most-read" },
    });
    // "Zebra crossing" has no recorded views: it sorts last because its count
    // is unknown, not because it is the least read.
    expect(visibleTitles()).toEqual([
      "Anchor essay",
      "Middle piece",
      "Zebra crossing",
    ]);
  });

  it("sorts drafts by their own edit time", () => {
    stubStats();
    renderManager({ tab: "drafts" });
    expect(visibleTitles()).toEqual(["Draft about zebras", "Older draft"]);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "oldest" },
    });
    expect(visibleTitles()).toEqual(["Older draft", "Draft about zebras"]);
  });
});

describe("posts manager — the PDS cursor is the real pagination", () => {
  it("keeps the older-posts link and says what the search covers", () => {
    stubStats();
    renderManager({ nextCursor: "cursor-abc" });
    const older = screen.getByRole("link", { name: /older posts/i });
    expect(older.getAttribute("href")).toBe("/dashboard?cursor=cursor-abc");
    screen.getByText(/on this page/i);
  });

  it("claims no page scope when the whole list is loaded", () => {
    stubStats();
    renderManager();
    expect(screen.queryByRole("link", { name: /older posts/i })).toBeNull();
    expect(screen.queryByText(/on this page/i)).toBeNull();
  });
});

describe("posts manager — absence vs emptiness", () => {
  it("says a failed posts read failed, instead of showing an empty archive", () => {
    stubStats();
    renderManager({ rows: null });
    screen.getByText(/couldn't be loaded right now/i);
    expect(screen.queryByText(/no posts yet/i)).toBeNull();
  });

  it("says a failed drafts read failed", () => {
    stubStats();
    renderManager({ drafts: null, tab: "drafts" });
    screen.getByText(/drafts couldn't be loaded right now/i);
  });

  it("teaches the first step when there is genuinely nothing yet", () => {
    stubStats();
    renderManager({ rows: [], drafts: [] });
    screen.getByRole("heading", { name: /no posts yet/i });
    screen.getByRole("link", { name: /write your first post/i });
    // No search or sort furniture over an empty account.
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("points at the drafts tab when nothing is published but work is in progress", () => {
    stubStats();
    renderManager({ rows: [] });
    screen.getByText(/nothing published yet/i);
    screen.getByRole("button", { name: /drafts tab/i });
  });

  it("offers a way to start when the drafts tab is empty", () => {
    stubStats();
    renderManager({ drafts: [], tab: "drafts" });
    screen.getByText(/no drafts in progress/i);
    screen.getByRole("link", { name: /start something new/i });
  });
});

describe("posts manager — row actions survive the rebuild", () => {
  it("keeps edit, announce and delete on a published row", async () => {
    stubStats();
    renderManager({ rows: [POSTS[0]], drafts: [] });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    screen.getByRole("link", { name: "Edit" });
    screen.getByRole("button", { name: "Announce" });
    screen.getByRole("button", { name: "Delete" });
  });

  it("swaps announce for the announced link plus a deliberate re-announce", () => {
    stubStats();
    renderManager({
      rows: [
        {
          ...POSTS[0],
          announced: { did: "did:plc:abc123", postRkey: "3lbskypost01" },
        },
      ],
      drafts: [],
    });
    const link = screen.getByRole("link", { name: /announced/i });
    expect(link.getAttribute("href")).toBe(
      "https://bsky.app/profile/did:plc:abc123/post/3lbskypost01",
    );
    screen.getByRole("button", { name: /announce again/i });
  });

  it("hides edit on a post written in another app, but keeps delete", () => {
    stubStats();
    renderManager({
      rows: [{ ...POSTS[0], editable: false }],
      drafts: [],
    });
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    screen.getByText(/written in another app/i);
    screen.getByRole("button", { name: "Delete" });
  });

  it("keeps resume on a draft row", () => {
    stubStats();
    renderManager({ tab: "drafts" });
    const resume = screen.getAllByRole("link", { name: "Resume" })[0];
    expect(resume.getAttribute("href")).toBe("/write?draft=d1");
  });
});
