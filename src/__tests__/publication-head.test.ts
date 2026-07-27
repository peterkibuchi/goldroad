// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Route } from "../routes/@{$handle}.index";

/** The publication page's head, driven directly with loader data (the route
 * head function is pure) — pins the RSS discovery link. */
type HeadFn = (ctx: { loaderData?: unknown }) => {
  links?: Array<Record<string, string>>;
};

const head = (Route.options as unknown as { head: HeadFn }).head;

const loaderData = {
  ident: "writer.example",
  publication: {
    name: "The Long Way",
    description: "Essays.",
    url: "https://trygoldroad.com/@writer.example",
  },
  publicationAtUri:
    "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
  posts: [],
  nextCursor: null,
};

describe("publication page head — feed discovery", () => {
  it("advertises the publication's RSS feed from the canonical origin", () => {
    const { links } = head({ loaderData });
    expect(links).toContainEqual({
      rel: "alternate",
      type: "application/rss+xml",
      title: "The Long Way — RSS",
      href: "https://trygoldroad.com/@writer.example/rss.xml",
    });
  });

  it("keeps the feed link when no publication record exists (ident title)", () => {
    const { links } = head({
      loaderData: { ...loaderData, publication: null, publicationAtUri: null },
    });
    expect(links).toContainEqual({
      rel: "alternate",
      type: "application/rss+xml",
      title: "writer.example — RSS",
      href: "https://trygoldroad.com/@writer.example/rss.xml",
    });
  });
});
