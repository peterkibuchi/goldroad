import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// useLocation needs a live TanStack Router context this test doesn't set up
// (only ReportLink reads it) — stubbed the same way the other reader suites do.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example/3lyk73wxnok2f" }),
}));

import { DocumentArticle } from "#/components/document-article";
import { WriterSurface } from "#/components/writer-surface";
import { type BasicTheme, parseTheme } from "#/lib/theme";
import { PublicationView } from "#/routes/@{$handle}.index";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const rgb = (r: number, g: number, b: number) => ({ r, g, b });

/** A dark, warm theme — visibly not our default palette. */
const theme: BasicTheme = {
  background: rgb(18, 17, 16),
  foreground: rgb(240, 236, 228),
  accent: rgb(226, 160, 60),
  accentForeground: rgb(18, 17, 16),
};

const baseDoc = {
  title: "Publishing on the open network",
  textContent: "Full body text, with [a link](https://example.com) in it.",
  publishedAt: "2026-01-05T00:00:00.000Z",
};

const post = {
  rkey: "3lyk73wxnok2f",
  title: "The morning the presses stopped",
  description: null,
  publishedAt: "2026-01-05T00:00:00.000Z",
  coverPath: null,
  readingMinutes: 4,
};

/** The single element a page's theme lands on, or null when it has none. */
function themedRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-writer-theme]");
}

describe("WriterSurface — whose appearance a page follows", () => {
  it("paints the author's colours onto the tokens the page already uses", () => {
    const { container } = render(
      <WriterSurface theme={theme}>
        <p>words</p>
      </WriterSurface>,
    );
    const style = themedRoot(container)?.getAttribute("style") ?? "";
    expect(style).toContain("--color-paper: rgb(18 17 16)");
    expect(style).toContain("--color-ink: rgb(240 236 228)");
    expect(style).toContain("--color-spot: rgb(226 160 60)");
    expect(style).toContain("--color-spot-foreground: rgb(18 17 16)");
  });

  it("is never a Goldroad surface — our dark-mode toggle cannot reach it", () => {
    const { container } = render(
      <WriterSurface theme={theme}>
        <p>words</p>
      </WriterSurface>,
    );
    // `.goldroad-surface` is what scopes [data-theme="dark"] in styles.css.
    // A writer's page carrying it would let a reader's toggle restyle
    // someone else's publication.
    expect(container.querySelector(".goldroad-surface")).toBeNull();
  });

  it("adds no attribute and no style at all without a theme", () => {
    const { container } = render(
      <WriterSurface theme={null}>
        <p>words</p>
      </WriterSurface>,
    );
    expect(themedRoot(container)).toBeNull();
    expect(container.firstElementChild?.getAttribute("style")).toBeNull();
  });

  it("still renders the page in the default palette when there is no theme", () => {
    const { container } = render(
      <WriterSurface theme={null}>
        <p>words</p>
      </WriterSurface>,
    );
    expect(container.firstElementChild?.className).toContain("bg-paper");
    expect(container.firstElementChild?.className).toContain("text-ink");
    expect(screen.getByText("words")).toBeTruthy();
  });
});

describe("a post page in its author's colours", () => {
  it("applies the theme to the article", () => {
    const { container } = render(
      <DocumentArticle doc={baseDoc} ident="writer.example" theme={theme} />,
    );
    const style = themedRoot(container)?.getAttribute("style") ?? "";
    expect(style).toContain("--color-paper: rgb(18 17 16)");
    expect(style).toContain("--color-ink: rgb(240 236 228)");
    // The writer's words are still the page — theming changes colour, not copy.
    expect(screen.getByText("Publishing on the open network")).toBeTruthy();
  });

  it("marks the writer's prose so their accent lands on links inside it", () => {
    const { container } = render(
      <DocumentArticle doc={baseDoc} ident="writer.example" theme={theme} />,
    );
    // The accent's job in the lexicon is links; the CSS rule that does it is
    // scoped to [data-writer-theme] .gr-prose, so both hooks must be present.
    expect(
      container.querySelector("[data-writer-theme] .gr-prose a"),
    ).not.toBeNull();
  });

  it("renders unthemed — no attribute, no inline colour — when the author has none", () => {
    const { container } = render(
      <DocumentArticle doc={baseDoc} ident="writer.example" />,
    );
    expect(themedRoot(container)).toBeNull();
    expect(screen.getByText("Publishing on the open network")).toBeTruthy();
  });
});

describe("a publication page in its author's colours", () => {
  it("applies the theme to the archive", () => {
    const { container } = render(
      <PublicationView
        ident="writer.example"
        iconPath={null}
        nextCursor={null}
        posts={[post]}
        publication={{ name: "The Long Way" }}
        theme={theme}
      />,
    );
    const style = themedRoot(container)?.getAttribute("style") ?? "";
    expect(style).toContain("--color-paper: rgb(18 17 16)");
    expect(screen.getByText("The Long Way")).toBeTruthy();
    expect(screen.getByText("The morning the presses stopped")).toBeTruthy();
  });

  it("renders unthemed when the author has no theme", () => {
    const { container } = render(
      <PublicationView
        ident="writer.example"
        iconPath={null}
        nextCursor={null}
        posts={[post]}
        publication={{ name: "The Long Way" }}
      />,
    );
    expect(themedRoot(container)).toBeNull();
  });
});

describe("any atproto author's theme, not only ours", () => {
  /** A publication record as a non-Goldroad app would leave it on a PDS. */
  const leafletPublication = {
    $type: "site.standard.publication",
    name: "Notes from Elsewhere",
    url: "https://elsewhere.leaflet.pub",
    basicTheme: {
      $type: "site.standard.theme.basic",
      accent: { $type: "site.standard.theme.color#rgb", r: 226, g: 160, b: 60 },
      accentForeground: {
        $type: "site.standard.theme.color#rgb",
        r: 18,
        g: 17,
        b: 16,
      },
      background: {
        $type: "site.standard.theme.color#rgb",
        r: 18,
        g: 17,
        b: 16,
      },
      foreground: {
        $type: "site.standard.theme.color#rgb",
        r: 240,
        g: 236,
        b: 228,
      },
    },
  };

  it("honours a theme written by another app on the shared lexicon", () => {
    // This is the interop argument paying off: the record was never written
    // by Goldroad, and its publication URL is not one of ours.
    const parsed = parseTheme(leafletPublication.basicTheme);
    expect(parsed).toEqual(theme);

    const { container } = render(
      <PublicationView
        ident="elsewhere.example"
        iconPath={null}
        nextCursor={null}
        posts={[post]}
        publication={leafletPublication}
        theme={parsed}
      />,
    );
    const style = themedRoot(container)?.getAttribute("style") ?? "";
    expect(style).toContain("--color-paper: rgb(18 17 16)");
    expect(style).toContain("--color-spot: rgb(226 160 60)");
  });

  it("honours it on their post pages too", () => {
    const { container } = render(
      <DocumentArticle
        doc={baseDoc}
        ident="elsewhere.example"
        publicationName="Notes from Elsewhere"
        theme={parseTheme(leafletPublication.basicTheme)}
      />,
    );
    expect(themedRoot(container)?.getAttribute("style")).toContain(
      "--color-ink: rgb(240 236 228)",
    );
  });
});

describe("degrading correctly — a theme can never break a reader's page", () => {
  const cases: Array<[string, unknown]> = [
    ["no basicTheme field at all", undefined],
    ["an explicit null", null],
    ["a string where an object belongs", "dark"],
    ["an empty object", {}],
    [
      "a partial theme — background and foreground only",
      {
        background: rgb(0, 0, 0),
        foreground: rgb(255, 255, 255),
      },
    ],
    [
      "an out-of-range channel",
      {
        accent: rgb(999, 0, 0),
        accentForeground: rgb(0, 0, 0),
        background: rgb(0, 0, 0),
        foreground: rgb(255, 255, 255),
      },
    ],
    [
      "a colour smuggling CSS instead of numbers",
      {
        accent: "#fff; position: fixed; inset: 0",
        accentForeground: rgb(0, 0, 0),
        background: rgb(0, 0, 0),
        foreground: rgb(255, 255, 255),
      },
    ],
    [
      "channels as strings",
      {
        accent: { r: "12", g: "12", b: "12" },
        accentForeground: rgb(0, 0, 0),
        background: rgb(0, 0, 0),
        foreground: rgb(255, 255, 255),
      },
    ],
  ];

  for (const [label, basicTheme] of cases) {
    it(`falls back to the default palette for ${label}`, () => {
      const parsed = parseTheme(basicTheme);
      expect(parsed).toBeNull();

      const { container } = render(
        <DocumentArticle doc={baseDoc} ident="writer.example" theme={parsed} />,
      );
      // No attribute, no inline custom properties, and — the point — the
      // page still renders the writer's words.
      expect(themedRoot(container)).toBeNull();
      expect(screen.getByText("Publishing on the open network")).toBeTruthy();
      expect(screen.getByText(/Full body text/)).toBeTruthy();
    });
  }

  it("never half-applies: a theme missing one colour applies none of the others", () => {
    const halfDark = parseTheme({
      background: rgb(0, 0, 0),
      accent: rgb(226, 160, 60),
      accentForeground: rgb(0, 0, 0),
      // foreground missing — applying the rest would be black text on black.
    });
    expect(halfDark).toBeNull();
    const { container } = render(
      <WriterSurface theme={halfDark}>
        <p>words</p>
      </WriterSurface>,
    );
    expect(container.firstElementChild?.getAttribute("style")).toBeNull();
  });
});

/**
 * Who wins when the author and the reader disagree — and who wins when only
 * one of them has said anything at all.
 *
 * The CSS is one selector (`[data-theme="dark"]
 * .writer-surface:not([data-writer-theme])` in styles.css) and it cannot be
 * asserted through jsdom, which applies no stylesheets. What CAN be pinned is
 * the pair of hooks that selector keys on, and pinning them is the point: the
 * rule is only correct while an unthemed page is markable as such and a themed
 * page is not.
 */
describe("an unthemed page follows the reader; a themed one does not", () => {
  it("marks an unthemed page as reader-themeable — no author answer to defer to", () => {
    const { container } = render(
      <WriterSurface theme={null}>
        <p>Body</p>
      </WriterSurface>,
    );
    const root = container.firstElementChild;
    expect(root?.classList.contains("writer-surface")).toBe(true);
    // The absence the dark-mode rule selects on. An author who set nothing has
    // expressed no preference, so the reader's stands.
    expect(root?.hasAttribute("data-writer-theme")).toBe(false);
  });

  it("marks a themed page as the author's, out of the reader toggle's reach", () => {
    const { container } = render(
      <WriterSurface theme={theme}>
        <p>Body</p>
      </WriterSurface>,
    );
    const root = container.firstElementChild;
    expect(root?.classList.contains("writer-surface")).toBe(true);
    expect(root?.hasAttribute("data-writer-theme")).toBe(true);
  });

  it("gives a rejected theme the reader's page, not a white one", () => {
    // Same door as everywhere else: a theme we could not validate is absent,
    // and absent means the reader decides. A malformed record on a stranger's
    // PDS must not be able to force a light page on someone who chose dark.
    const { container } = render(
      <WriterSurface theme={parseTheme({ accent: rgb(1, 2, 3) })}>
        <p>Body</p>
      </WriterSurface>,
    );
    expect(container.firstElementChild?.hasAttribute("data-writer-theme")).toBe(
      false,
    );
  });
});
