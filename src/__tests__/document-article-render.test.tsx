import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    // The dek renders even though the body is non-empty — it is no longer
    // just a no-body fallback.
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

describe("DocumentArticle — engagement row", () => {
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

/**
 * The printer's mark. The two-surface rule says the platform disappears on a
 * reading page; the trust mandate says the platform has to be discoverable.
 * A printed book settles this the same way: the author owns the title page,
 * the printer's device sits small at the very end. So the writer's fact leads
 * and Goldroad gets exactly one line, last — never a band, never a badge.
 */
describe("DocumentArticle — the close", () => {
  it("leads with the writer's fact and closes with one Goldroad line", () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    const close = screen.getByText(/Goldroad — open-source/i).closest("footer");
    const lines = [...(close?.querySelectorAll("p") ?? [])].map(
      (p) => p.textContent ?? "",
    );
    expect(lines).toHaveLength(2);
    // The writer's line leads — year and publication, no rights claim. A
    // notice grants nothing under Berne, and asserting "all rights reserved"
    // would speak for a writer who may have chosen otherwise.
    expect(lines[0]).toMatch(/^\d{4} · .+$/);
    expect(lines[0]).not.toMatch(/all rights reserved/i);
    expect(lines[1]).toMatch(
      /^Goldroad — open-source, writer-owned publishing/,
    );
  });

  it("points that line at /open, from the canonical origin", () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    expect(
      screen
        .getByRole("link", { name: /goldroad — open-source/i })
        .getAttribute("href"),
    ).toBe("https://trygoldroad.com/open");
  });

  it("keeps the reading surface free of the marketing footer", () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    expect(screen.queryByRole("navigation", { name: "Open" })).toBeNull();
    expect(screen.queryByText(/leave anytime/i)).toBeNull();
  });
});

/**
 * The header's type scale, pinned because it has moved twice.
 *
 * The dek is the WRITER'S sentence. It belongs in the body serif; setting it in
 * the display face moved the writer's words into Goldroad's interface voice,
 * which is the one thing a reading page must not do. And its size has to sit
 * between the title and the byline, or the header descends large / very small /
 * small and the second-most-important line on the page becomes the weakest.
 */
describe("DocumentArticle — the header descends", () => {
  const withDek = () =>
    render(
      <DocumentArticle
        doc={{ ...baseDoc, description: "A one-sentence hook." }}
        ident="writer.example"
      />,
    );

  it("sets the header in the display face and leaves the prose in serif", () => {
    // Two faces, and the line between them is the point: furniture is display,
    // reading matter is serif. One face doing both is why the header used to
    // read as a greyed-out first paragraph.
    const { container } = withDek();
    const dek = screen.getByText("A one-sentence hook.");
    expect(dek.className).toContain("font-display");
    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("font-display");
    expect(h1?.className).toContain("font-bold");
    // The body keeps the serif: Prose sets no face, inheriting font-body.
    expect(container.querySelector(".gr-prose")?.className).not.toContain(
      "font-display",
    );
  });

  it("scales the header proportionally to the body, descending", () => {
    const { container } = withDek();
    const dek = screen.getByText("A one-sentence hook.");
    // Against a 17px (1.0625rem) body: title 2rem ~1.88x, dek 1.1875rem
    // ~1.12x — just above the body so it leads in — byline 0.875rem ~0.82x.
    expect(container.querySelector("h1")?.className).toContain("text-[2rem]");
    expect(dek.className).toContain("text-[1.1875rem]");
    // Scoped to the header: the handle also appears in the colophon.
    const byline = container
      .querySelector("header")
      ?.querySelector('a[href="/@writer.example"]');
    expect(byline?.closest("div")?.className).toContain("text-sm");
  });

  it("holds the dek to a readable measure", () => {
    withDek();
    expect(screen.getByText("A one-sentence hook.").className).toContain(
      "max-w-[52ch]",
    );
  });
});

/**
 * The reader's edition switch.
 *
 * An unthemed reading page follows the reader's system preference — which was
 * always honoured, but until now had no control outside our own chrome, so a
 * reader who wanted to read light on a dark machine had to go find the
 * homepage. On a themed page there is deliberately nothing to switch: the
 * author answered the question.
 */
describe("DocumentArticle — the reader's edition switch", () => {
  const rgb = (r: number, g: number, b: number) => ({ r, g, b });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.readerEdition;
    localStorage.clear();
  });

  it("offers the switch on a page whose author set no theme", async () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    // Mounted-only: the label names the edition it switches TO, and the server
    // cannot know the reader's system setting without varying cached HTML.
    expect(
      await screen.findByRole("button", { name: /read in/i }),
    ).toBeTruthy();
  });

  it("names the edition it switches to, not the one you are in", async () => {
    document.documentElement.dataset.theme = "dark";
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    expect(
      await screen.findByRole("button", { name: "Read in light" }),
    ).toBeTruthy();
  });

  const themed = () => ({
    background: rgb(18, 17, 16),
    foreground: rgb(240, 236, 228),
    accent: rgb(226, 160, 60),
    accentForeground: rgb(18, 17, 16),
  });

  it("is offered on a themed page too — the reader's eyes still count", async () => {
    render(
      <DocumentArticle doc={baseDoc} ident="writer.example" theme={themed()} />,
    );
    expect(
      await screen.findByRole("button", { name: /read in/i }),
    ).toBeTruthy();
  });

  it("offers the way back only once the reader is actually overriding", async () => {
    // Without "as published", a reader who once chose an edition could never
    // see a writer's colours again and the override would end theming.
    const { unmount } = render(
      <DocumentArticle doc={baseDoc} ident="writer.example" theme={themed()} />,
    );
    // Nothing chosen yet: the author's theme is what's showing, so there is
    // nothing to hand back.
    expect(screen.queryByRole("button", { name: "As published" })).toBeNull();
    unmount();

    document.documentElement.dataset.readerEdition = "dark";
    render(
      <DocumentArticle doc={baseDoc} ident="writer.example" theme={themed()} />,
    );
    expect(
      await screen.findByRole("button", { name: "As published" }),
    ).toBeTruthy();
  });

  it("never offers the way back on an unthemed page — nothing to go back to", async () => {
    document.documentElement.dataset.readerEdition = "dark";
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    await screen.findByRole("button", { name: /read in/i });
    expect(screen.queryByRole("button", { name: "As published" })).toBeNull();
  });

  it("hands the page back to its author, and stops overriding", async () => {
    document.documentElement.dataset.readerEdition = "dark";
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem("gr-appearance", "dark");
    render(
      <DocumentArticle doc={baseDoc} ident="writer.example" theme={themed()} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "As published" }),
    );
    // The stored choice is REMOVED, not set to "system": an untouched reader
    // and a reset one have to be the same reader.
    expect(localStorage.getItem("gr-appearance")).toBeNull();
    expect(document.documentElement.dataset.readerEdition).toBeUndefined();
  });

  it("repaints and remembers when the reader switches", async () => {
    render(<DocumentArticle doc={baseDoc} ident="writer.example" />);
    const button = await screen.findByRole("button", { name: "Read in dark" });
    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("gr-appearance")).toBe("dark");
    // And back: "light" is a stored CHOICE, while the attribute is removed so
    // the system can speak again on the next load.
    fireEvent.click(
      await screen.findByRole("button", { name: "Read in light" }),
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("gr-appearance")).toBe("light");
  });
});
