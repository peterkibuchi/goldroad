import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { filterPostsByQuery, groupPostsByMonth, monogram } from "#/lib/archive";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

/**
 * The archive page's own component tree lives inside a TanStack file route
 * (Route.useLoaderData), which needs a live router context to render. These
 * cases therefore drive the extracted pure display logic (~/lib/archive) plus
 * a faithful re-render of the row/thumbnail markup, which is what the visual
 * contract actually rests on — masthead identity, dek lines, month rhythm,
 * and a cover-less row that still holds the list's rhythm.
 */

/** Mirror of the route's PostThumb: cover → publication icon → monogram,
 * always in the same fixed-size box. */
function Thumb({
  coverPath,
  iconPath,
  title,
}: {
  coverPath: string | null;
  iconPath: string | null;
  title: string;
}) {
  if (coverPath || iconPath) {
    return (
      <img
        alt=""
        className="mt-1 h-20 w-20 shrink-0 object-cover"
        loading="lazy"
        src={(coverPath ?? iconPath) as string}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className="mt-1 flex h-20 w-20 shrink-0 items-center justify-center bg-ink/5 font-display text-2xl text-ink-soft/40"
      data-testid="thumb-placeholder"
    >
      {monogram(title)}
    </div>
  );
}

describe("archive thumbnail slot — no blank hole, constant rhythm", () => {
  it("renders the post's own cover when it has one", () => {
    render(<Thumb coverPath="/img/did/cover" iconPath={null} title="A post" />);
    const img = document.querySelector('img[alt=""]');
    expect(img?.getAttribute("src")).toBe("/img/did/cover");
    expect(img?.getAttribute("loading")).toBe("lazy");
  });

  it("falls back to the publication icon when the post has no cover", () => {
    render(<Thumb coverPath={null} iconPath="/img/did/icon" title="A post" />);
    expect(document.querySelector('img[alt=""]')?.getAttribute("src")).toBe(
      "/img/did/icon",
    );
  });

  it("falls back to a quiet monogram — never an empty slot — with neither", () => {
    render(<Thumb coverPath={null} iconPath={null} title="Substack notes" />);
    const placeholder = screen.getByTestId("thumb-placeholder");
    expect(placeholder.textContent).toBe("S");
    // Same fixed box as the image arms, so cover-less rows keep the rhythm.
    expect(placeholder.className).toContain("h-20");
    expect(placeholder.className).toContain("w-20");
    // Decorative only — it must not reach assistive tech as content.
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("archive month grouping — the skim rhythm", () => {
  const posts = [
    { rkey: "c", title: "March piece", publishedAt: "2026-03-02T00:00:00Z" },
    { rkey: "b", title: "Feb piece", publishedAt: "2026-02-20T00:00:00Z" },
    {
      rkey: "a",
      title: "Older Feb piece",
      publishedAt: "2026-02-01T00:00:00Z",
    },
  ];

  it("emits one header per month, in list order, with its posts beneath", () => {
    const groups = groupPostsByMonth(posts);
    expect(groups.map((g) => g.label)).toEqual(["March 2026", "February 2026"]);
    expect(groups[1].posts.map((p) => p.rkey)).toEqual(["b", "a"]);
  });

  it("renders the group headers as quiet caps above their rows", () => {
    render(
      groupPostsByMonth(posts).map((group) => (
        <section key={group.label}>
          <p className="font-display text-ink-soft text-xs uppercase tracking-wide">
            {group.label}
          </p>
          <ul>
            {group.posts.map((p) => (
              <li key={p.rkey}>{p.title}</li>
            ))}
          </ul>
        </section>
      )),
    );
    const header = screen.getByText("February 2026");
    expect(header.className).toContain("uppercase");
    expect(header.className).toContain("text-ink-soft");
    expect(screen.getByText("March piece")).toBeDefined();
  });
});

describe("archive search affordance — client-side over loaded rows", () => {
  const posts = [
    { title: "Publishing on the open network", description: "A primer." },
    { title: "Newsletters are coming", description: null },
  ];

  it("narrows to matching titles or deks without a new fetch", () => {
    expect(filterPostsByQuery(posts, "primer")).toEqual([posts[0]]);
    expect(filterPostsByQuery(posts, "newsletters")).toEqual([posts[1]]);
  });

  it("an empty query is 'no filter', never 'match nothing'", () => {
    expect(filterPostsByQuery(posts, "  ")).toHaveLength(2);
  });
});

/**
 * The archive page's close, checked at the source level for the reason given
 * at the top of this file: its component tree needs a live router context.
 * What matters is the shape — the writer's items (open network, RSS) lead,
 * and Goldroad's single printer's-mark line points at /open, minted from the
 * canonical origin so a shared page never carries a preview hostname.
 */
describe("archive close — printer's mark", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "routes", "@{$handle}.index.tsx"),
    "utf8",
  );

  it("closes with the open-source line, pointed at /open", () => {
    expect(source).toContain("Goldroad — open-source, writer-owned publishing");
    expect(source).toMatch(/CANONICAL_ORIGIN\}\/open/);
  });

  it("no longer sends readers to the marketing homepage instead", () => {
    expect(source).not.toContain("via Goldroad");
  });
});
