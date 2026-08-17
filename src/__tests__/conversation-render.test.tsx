import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only ReportLink reads the router (for the "report this page" URL); stub the
// one hook, exactly as document-article-render.test.tsx does.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example/3lyk73wxnok2f" }),
}));

import { Conversation } from "#/components/conversation";
import { DocumentArticle } from "#/components/document-article";
import type { PostConversation, Reply } from "#/lib/comments";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const THREAD_URL =
  "https://bsky.app/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/post/3lyk73wxnok2f";

function reply(overrides: Partial<Reply> = {}): Reply {
  return {
    uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3lyreply1",
    authorHandle: "reader.example",
    authorName: "A Reader",
    text: "This clarified something I'd been stuck on.",
    timestamp: "2026-02-01T10:00:01.000Z",
    url: "https://bsky.app/profile/reader.example/post/3lyreply1",
    byAuthor: false,
    ...overrides,
  };
}

function conversation(
  overrides: Partial<PostConversation> = {},
): PostConversation {
  return {
    replies: [reply()],
    threadUrl: THREAD_URL,
    hasMore: false,
    ...overrides,
  };
}

const baseDoc = {
  title: "Publishing on the open network",
  textContent: "Full body text here.",
  publishedAt: "2026-01-05T00:00:00.000Z",
};

describe("Conversation — what a reader sees", () => {
  it("shows each reply's author, handle and words", () => {
    render(<Conversation conversation={conversation()} />);
    expect(screen.getByText("A Reader")).toBeDefined();
    expect(screen.getByText(/@reader\.example/)).toBeDefined();
    expect(
      screen.getByText("This clarified something I'd been stuck on."),
    ).toBeDefined();
  });

  it("shows the handle alone when there is no display name", () => {
    render(
      <Conversation
        conversation={conversation({
          replies: [reply({ authorName: null })],
        })}
      />,
    );
    expect(screen.getByText("@reader.example")).toBeDefined();
  });

  it("links each reply to itself on Bluesky, in a new tab", () => {
    render(<Conversation conversation={conversation()} />);
    const link = screen
      .getAllByRole("link")
      .find(
        (a) =>
          a.getAttribute("href") ===
          "https://bsky.app/profile/reader.example/post/3lyreply1",
      );
    expect(link).toBeDefined();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("dates a reply with a machine-readable time element", () => {
    render(<Conversation conversation={conversation()} />);
    const time = document.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-02-01T10:00:01.000Z");
    expect(time?.textContent).toBe("1 Feb 2026");
  });

  it("marks a reply from the writer themselves", () => {
    render(
      <Conversation
        conversation={conversation({ replies: [reply({ byAuthor: true })] })}
      />,
    );
    expect(screen.getByText(/author/)).toBeDefined();
  });

  it("renders reply text as text — never as markup", () => {
    render(
      <Conversation
        conversation={conversation({
          replies: [reply({ text: "<img src=x onerror=alert(1)>" })],
        })}
      />,
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(document.querySelector("img[onerror]")).toBeNull();
  });

  it("fetches no images — no reader's browser calls a third-party CDN", () => {
    render(<Conversation conversation={conversation()} />);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("Conversation — the affordance to join in", () => {
  it("labels the link by outcome, not by mechanism", () => {
    render(<Conversation conversation={conversation()} />);
    const join = screen.getByRole("link", { name: /Reply on Bluesky/ });
    expect(join.getAttribute("href")).toBe(THREAD_URL);
    // Never named after the plumbing.
    expect(document.body.textContent).not.toMatch(
      /AppView|XRPC|at:\/\/|lexicon|record/i,
    );
  });

  it("says so when the thread holds more than the page shows", () => {
    render(<Conversation conversation={conversation({ hasMore: true })} />);
    expect(
      screen.getByRole("link", { name: /Read the rest and reply on Bluesky/ }),
    ).toBeDefined();
  });

  it("states plainly who moderates the replies, in one line", () => {
    render(<Conversation conversation={conversation()} />);
    expect(
      screen.getByText(/Bluesky moderates them, not Goldroad/),
    ).toBeDefined();
  });
});

describe("Conversation — a thread too big to carry here", () => {
  /** What ~/lib/comments returns for an over-cap thread: no rows, a URL, more. */
  const overCap = () => conversation({ replies: [], hasMore: true });

  it("keeps the section, as a heading and a way in", () => {
    // The defect: an over-cap thread used to make the whole section disappear —
    // on exactly the posts with the most conversation to point a reader at.
    render(<Conversation conversation={overCap()} />);
    expect(screen.getByRole("heading", { name: "Conversation" })).toBeDefined();
    const join = screen.getByRole("link", {
      name: /Read the rest and reply on Bluesky/,
    });
    expect(join.getAttribute("href")).toBe(THREAD_URL);
  });

  it("renders no rows, and no list announcing zero items", () => {
    render(<Conversation conversation={overCap()} />);
    expect(document.querySelectorAll("li")).toHaveLength(0);
    expect(document.querySelectorAll("ul")).toHaveLength(0);
  });

  it("does not promise replies that aren't below it", () => {
    render(<Conversation conversation={overCap()} />);
    expect(document.body.textContent).not.toMatch(
      /Replies from Bluesky|moderates them/,
    );
    expect(
      screen.getByText(/conversation is on Bluesky, where it was shared/),
    ).toBeDefined();
    // Still not an empty state, and still no plumbing.
    expect(document.body.textContent).not.toMatch(
      /first to|no replies|too large|AppView|at:\/\//i,
    );
  });

  it("shows the rows and the usual line whenever there are any", () => {
    render(<Conversation conversation={conversation()} />);
    expect(document.querySelectorAll("ul")).toHaveLength(1);
    expect(
      screen.getByText(/Bluesky moderates them, not Goldroad/),
    ).toBeDefined();
  });
});

describe("DocumentArticle — a conversation only appears when there is one", () => {
  it("renders nothing at all for a post with no announcement", () => {
    render(
      <DocumentArticle
        conversation={null}
        doc={baseDoc}
        ident="writer.example"
      />,
    );
    expect(screen.queryByText("Conversation")).toBeNull();
    // No empty box, no invitation to be first, no mention of Bluesky replies.
    expect(document.body.textContent).not.toMatch(
      /first to|no replies|comment/i,
    );
  });

  it("renders nothing when the conversation prop is simply absent", () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    expect(screen.queryByText("Conversation")).toBeNull();
  });

  it("still renders the post in full when replies are missing", () => {
    render(
      <DocumentArticle
        conversation={null}
        doc={baseDoc}
        ident="writer.example"
      />,
    );
    expect(screen.getByText("Publishing on the open network")).toBeDefined();
    expect(screen.getByText("Full body text here.")).toBeDefined();
  });

  it("places the conversation after the writer's words", () => {
    render(
      <DocumentArticle
        conversation={conversation()}
        doc={baseDoc}
        ident="writer.example"
      />,
    );
    const body = screen.getByText("Full body text here.");
    const heading = screen.getByText("Conversation");
    expect(
      body.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
