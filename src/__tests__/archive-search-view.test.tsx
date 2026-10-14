import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The archive's search as a reader meets it: a form that works with
 * JavaScript off, matches marked in the results, the writer's words never
 * parsed as HTML, and an honest line when only titles were searched.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example" }),
}));

import {
  MAX_QUERY_TERMS,
  normalizeQuery,
  snippetParts,
  toMatchExpression,
} from "../lib/search-query";
import {
  type ArchiveSearch,
  PublicationView,
} from "../routes/@{$handle}.index";

afterEach(cleanup);

const H = "\u0002";
const C = "\u0003";

const POST = {
  rkey: "3ma",
  title: "Slow gardens",
  description: null,
  publishedAt: "2026-09-30T10:00:00.000Z",
  coverPath: null,
  readingMinutes: 4,
};

function view(search: ArchiveSearch | null, nextCursor: string | null = null) {
  return render(
    <PublicationView
      iconPath={null}
      ident="writer.example"
      nextCursor={nextCursor}
      posts={search ? [] : [POST]}
      publication={null}
      search={search}
    />,
  );
}

const full = (hits: ArchiveSearch["hits"], more = false): ArchiveSearch => ({
  q: "slow",
  scope: "full",
  hits,
  more,
});

describe("archive search — the form", () => {
  it("is a GET form to this page, so it works without JavaScript", () => {
    view(null);
    const box = screen.getByRole("searchbox", { name: "Search posts" });
    const form = box.closest("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe("/@writer.example");
    expect(box.getAttribute("name")).toBe("q");
    expect(screen.getByRole("button", { name: "Search" })).toBeDefined();
  });

  it("keeps the query in the box on the results page", () => {
    view(full([]));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "slow",
    );
  });
});

describe("archive search — the results", () => {
  it("marks the matches in the title and the passage", () => {
    view(
      full([
        {
          rkey: "3ma",
          title: `${H}Slow${C} gardens`,
          snippet: `…a ${H}slow${C} spring…`,
          description: "",
          publishedAt: null,
        },
      ]),
    );
    const marks = document.querySelectorAll("mark");
    expect([...marks].map((m) => m.textContent)).toEqual(["Slow", "slow"]);
    expect(screen.getByRole("status").textContent).toContain(
      "1 post matches “slow”",
    );
    expect(
      screen.getByRole("link", { name: /Slow gardens/ }).getAttribute("href"),
    ).toBe("/@writer.example/3ma");
  });

  it("shows the writer's words as text, never as markup", () => {
    view(
      full([
        {
          rkey: "3ma",
          title: "<img src=x onerror=alert(1)>",
          snippet: `<b>${H}slow${C}</b>`,
          description: "",
          publishedAt: null,
        },
      ]),
    );
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
  });

  it("falls back to the summary when the body had no passage to show", () => {
    view(
      full([
        {
          rkey: "3ma",
          title: "Title",
          snippet: "",
          description: "A summary",
          publishedAt: null,
        },
      ]),
    );
    expect(screen.getByText("A summary")).toBeDefined();
  });

  it("says when only titles and summaries were searched", () => {
    view({ ...full([]), scope: "titles" });
    expect(
      screen.getByText(
        /Searched the titles and summaries of the \d+ most recent posts/,
      ),
    ).toBeDefined();
  });

  it("says the posts didn't load, rather than that nothing matched", () => {
    render(
      <PublicationView
        iconPath={null}
        ident="writer.example"
        nextCursor={null}
        posts={[]}
        postsError="unavailable"
        publication={null}
        search={{ ...full([]), scope: "titles" }}
      />,
    );
    expect(
      screen.getByText(/posts couldn't be loaded right now/),
    ).toBeDefined();
    expect(screen.queryByText(/Try fewer or different words/)).toBeNull();
  });

  it("doesn't say it for a full-text search", () => {
    view(full([]));
    expect(screen.queryByText(/Searched the titles/)).toBeNull();
  });

  it("offers a way on from an empty result", () => {
    view(full([]));
    expect(screen.getByRole("status").textContent).toContain(
      "No posts match “slow”",
    );
    expect(
      screen
        .getByRole("link", { name: "browse every post" })
        .getAttribute("href"),
    ).toBe("/@writer.example");
  });

  it("says there are more than it showed", () => {
    view(
      full(
        [
          {
            rkey: "3ma",
            title: "T",
            snippet: "",
            description: "",
            publishedAt: null,
          },
        ],
        true,
      ),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "The 1 closest matches for “slow”",
    );
    expect(screen.getByText(/Add a word to narrow it down/)).toBeDefined();
  });

  it("drops the archive's paging while searching", () => {
    view(full([]), "cursor");
    expect(screen.queryByRole("link", { name: /Older posts/ })).toBeNull();
    const status = screen.getByRole("status");
    expect(
      within(status)
        .getByRole("link", { name: "All posts" })
        .getAttribute("href"),
    ).toBe("/@writer.example");
  });
});

describe("what a typed query becomes", () => {
  it("quotes every word, so nothing typed is FTS5 syntax", () => {
    expect(toMatchExpression('slow "garden" NOT title:xy*')).toBe(
      '"slow"* "garden"* "not"* "title"* "xy"*',
    );
  });

  it("matches a single character exactly, not as every word it starts", () => {
    expect(toMatchExpression("a garden")).toBe('"a" "garden"*');
  });

  it("keeps letters and digits in any script, and drops the rest", () => {
    expect(toMatchExpression("café 東京 2026")).toBe('"café"* "東京"* "2026"*');
    expect(toMatchExpression("*** ???")).toBeNull();
  });

  it("dedupes and caps the words", () => {
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(toMatchExpression(many)?.split(" ")).toHaveLength(MAX_QUERY_TERMS);
    expect(toMatchExpression("Slow slow SLOW")).toBe('"slow"*');
  });

  it("reads a URL value only if it is a string", () => {
    expect(normalizeQuery(undefined)).toBe("");
    expect(normalizeQuery(42)).toBe("");
  });

  it("splits a snippet into plain and matched runs", () => {
    expect(snippetParts(`a ${H}b${C} c ${H}d${C}`)).toEqual([
      { text: "a ", hit: false },
      { text: "b", hit: true },
      { text: " c ", hit: false },
      { text: "d", hit: true },
    ]);
    expect(snippetParts("")).toEqual([]);
  });
});
