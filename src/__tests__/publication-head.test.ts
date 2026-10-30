// @vitest-environment node
import { describe, expect, it } from "vitest";

import { publicationCanonicalUrl, Route } from "../routes/@{$handle}.index";

/** The publication page's head, driven directly with loader data (the route
 * head function is pure) — pins the RSS discovery link. */
type HeadFn = (ctx: { loaderData?: unknown }) => {
  meta?: Array<Record<string, string>>;
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
  posts: [{ rkey: "3abc2345678df", title: "A post" }],
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

describe("publication page head — the link preview", () => {
  it("names the page and describes the default card it shows", () => {
    const { meta, links } = head({ loaderData });
    expect(links).toContainEqual({
      rel: "canonical",
      href: "https://trygoldroad.com/@writer.example",
    });
    expect(meta).toContainEqual({
      property: "og:url",
      content: "https://trygoldroad.com/@writer.example",
    });
    expect(meta).toContainEqual({
      property: "og:image:width",
      content: "1200",
    });
    expect(meta).toContainEqual({
      property: "og:image:height",
      content: "630",
    });
    expect(meta?.some((m) => m.property === "og:image:alt")).toBe(true);
  });
});

describe("publication page head — indexing", () => {
  const robots = (data: unknown) =>
    head({ loaderData: data }).meta?.find((m) => m.name === "robots");

  it("indexes an archive with posts", () => {
    expect(robots(loaderData)).toBeUndefined();
  });

  it("keeps an empty archive out of the index", () => {
    expect(robots({ ...loaderData, posts: [] })).toEqual({
      name: "robots",
      content: "noindex",
    });
  });
});

describe("publicationCanonicalUrl", () => {
  it("is the record's url on the first page", () => {
    expect(
      publicationCanonicalUrl({
        ident: "writer.example",
        publicationUrl: "https://writer.leaflet.pub",
      }),
    ).toBe("https://writer.leaflet.pub");
  });

  it("is this page, lowercased, when the record has no https url", () => {
    expect(publicationCanonicalUrl({ ident: "Writer.Example" })).toBe(
      "https://trygoldroad.com/@writer.example",
    );
    expect(
      publicationCanonicalUrl({
        ident: "writer.example",
        publicationUrl: "at://not-a-web-address",
      }),
    ).toBe("https://trygoldroad.com/@writer.example");
  });

  it("moves a legacy-origin url onto the canonical origin", () => {
    expect(
      publicationCanonicalUrl({
        ident: "writer.example",
        publicationUrl: "https://goldroad.kibuchi.workers.dev/@writer.example",
      }),
    ).toBe("https://trygoldroad.com/@writer.example");
  });

  it("gives an older page here its own canonical, not the first page's", () => {
    expect(
      publicationCanonicalUrl({
        ident: "writer.example",
        publicationUrl: "https://trygoldroad.com/@writer.example",
        cursor: "3abc2345678df",
      }),
    ).toBe("https://trygoldroad.com/@writer.example?cursor=3abc2345678df");
  });

  it("names no canonical for an older page of another site's archive", () => {
    expect(
      publicationCanonicalUrl({
        ident: "writer.example",
        publicationUrl: "https://writer.leaflet.pub",
        cursor: "3abc2345678df",
      }),
    ).toBeNull();
  });
});
