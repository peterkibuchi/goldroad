import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// useLocation needs a live TanStack Router context this test doesn't set up
// (only ReportLink reads it, for the "report this page" URL) — stub it the
// same way other suites stub a single hook out of a larger library import.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example/3lyk73wxnok2f" }),
}));

import { DocumentArticle } from "#/components/document-article";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const baseDoc = {
  title: "Publishing on the open network",
  textContent: "Full body text here.",
  publishedAt: "2026-01-05T00:00:00.000Z",
};

describe("DocumentArticle — title block (title -> dek -> byline)", () => {
  it("always shows the dek line when document.description is set", () => {
    render(
      <DocumentArticle
        doc={{ ...baseDoc, description: "A one-sentence hook." }}
        ident="writer.example"
      />,
    );
    expect(screen.getByText("A one-sentence hook.")).toBeDefined();
    // The dek renders even though the body is non-empty (owner decision #1:
    // no longer just a no-body fallback).
    expect(screen.getByText("Full body text here.")).toBeDefined();
  });

  it("omits the dek line entirely when there's no description", () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    expect(screen.queryByText(/hook/)).toBeNull();
  });

  it("renders the publication icon inline with the byline when present", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        ident="writer.example"
        publicationIcon={{
          did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
          cid: "bafkreiiconcid",
        }}
        publicationName="The Long Way"
      />,
    );
    // Decorative (alt=""), so it carries role="presentation", not "img" —
    // query the element itself and pin the /img proxy path.
    const avatar = document.querySelector('img[alt=""]');
    expect(avatar?.getAttribute("src")).toBe(
      "/img/did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa/bafkreiiconcid",
    );
  });

  it("falls back to a 'keeps its full text elsewhere' line for an empty body, without duplicating the dek", () => {
    render(
      <DocumentArticle
        doc={{
          title: "Mirrored elsewhere",
          description: "A one-sentence hook.",
          textContent: "",
        }}
        ident="writer.example"
      />,
    );
    // The dek shows once, under the H1 — the empty-body fallback no longer
    // re-renders the description a second time as substitute body text.
    expect(screen.getAllByText("A one-sentence hook.")).toHaveLength(1);
    expect(screen.getByText(/keeps its full text elsewhere/)).toBeDefined();
  });
});

describe("DocumentArticle — engagement row (owner decision #2)", () => {
  const threadUrl = "https://bsky.app/profile/writer.example/post/abc123";

  it("renders like/reply/repost+quote counts with quiet icons", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        engagement={{
          counts: {
            likeCount: 42,
            replyCount: 5,
            repostCount: 3,
            quoteCount: 1,
          },
          threadUrl,
        }}
        ident="writer.example"
      />,
    );
    expect(screen.getByText("42")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
    // repost + quote are summed into one figure (3 + 1 = 4).
    expect(screen.getByText("4")).toBeDefined();
  });

  it("links only the reply count to the bsky.app thread", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        engagement={{ counts: { replyCount: 5 }, threadUrl }}
        ident="writer.example"
      />,
    );
    const link = screen.getByRole("link", { name: /5/ });
    expect(link.getAttribute("href")).toBe(threadUrl);
  });

  it("renders nothing for an unannounced post (engagement is null)", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        engagement={null}
        ident="writer.example"
      />,
    );
    expect(screen.queryByTitle(/likes on Bluesky/)).toBeNull();
  });

  it("renders nothing when every count came back uncounted (honest silence, not a zero)", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        engagement={{ counts: {}, threadUrl }}
        ident="writer.example"
      />,
    );
    expect(screen.queryByRole("link", { name: /bsky/i })).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("DocumentArticle — end-of-post module", () => {
  it("renders a follow-on-Bluesky card with the publication name/description", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        ident="writer.example"
        publicationDescription="Essays on protocols."
        publicationName="The Long Way"
      />,
    );
    // The publication name appears twice by design: once in the byline row,
    // once as the follow-card's heading.
    expect(screen.getAllByText("The Long Way")).toHaveLength(2);
    expect(screen.getByText("Essays on protocols.")).toBeDefined();
    // ExternalLink appends a visually-hidden "(opens in new tab)" to the
    // accessible name — match on the visible half.
    const follow = screen.getByRole("link", {
      name: /Follow @writer\.example on Bluesky/,
    });
    expect(follow.getAttribute("href")).toBe(
      "https://bsky.app/profile/writer.example",
    );
  });

  it("links RSS to the publication's feed", () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    const rss = screen.getByRole("link", { name: "RSS" });
    expect(rss.getAttribute("href")).toBe("/@writer.example/rss.xml");
  });

  it("renders 'More from <publication>' with up to 3 related posts", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        ident="writer.example"
        publicationName="The Long Way"
        relatedPosts={[
          { rkey: "a", title: "Post A", publishedAt: "2026-01-01T00:00:00Z" },
          { rkey: "b", title: "Post B", publishedAt: null },
        ]}
      />,
    );
    expect(screen.getByText("More from The Long Way")).toBeDefined();
    const postA = screen.getByRole("link", { name: "Post A" });
    expect(postA.getAttribute("href")).toBe("/@writer.example/a");
    expect(screen.getByRole("link", { name: "Post B" })).toBeDefined();
  });

  it("omits the related-posts block entirely when there are none", () => {
    render(
      <DocumentArticle
        doc={baseDoc}
        ident="writer.example"
        relatedPosts={[]}
      />,
    );
    expect(screen.queryByText(/More from/)).toBeNull();
  });
});
