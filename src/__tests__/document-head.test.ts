// @vitest-environment node
import { describe, expect, it } from "vitest";

import { documentHead, isHiddenNotFound } from "../components/document-article";

/**
 * The link-tag convention is interop-load-bearing (standard.site: consumers,
 * incl. Bluesky's crawler, discover the backing record through it) — pin the
 * exact rel values and href shapes.
 */
describe("documentHead", () => {
  const loaderData = {
    doc: {
      title: "Hello Atmosphere",
      description: "An excerpt.",
      site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
      path: "/3abc2345678df",
    },
    ident: "writer.example",
    atUri:
      "at://did:plc:fake0000000000writer0000/site.standard.document/3abc2345678df",
    canonicalUrl: "https://goldroad.example/@writer.example/3abc2345678df",
  };

  it("emits rel=site.standard.document + rel=alternate at:// link tags", () => {
    const { links } = documentHead(loaderData);
    expect(links).toContainEqual({
      rel: "site.standard.document",
      href: loaderData.atUri,
    });
    expect(links).toContainEqual({ rel: "alternate", href: loaderData.atUri });
  });

  it("emits the canonical link + og:url for the composed URL", () => {
    const head = documentHead(loaderData);
    expect(head.links).toContainEqual({
      rel: "canonical",
      href: loaderData.canonicalUrl,
    });
    expect(head.meta).toContainEqual({
      property: "og:url",
      content: loaderData.canonicalUrl,
    });
  });

  it("emits og:title/og:description/og:type=article from the record", () => {
    const { meta } = documentHead(loaderData);
    expect(meta).toContainEqual({
      property: "og:title",
      content: "Hello Atmosphere",
    });
    expect(meta).toContainEqual({
      property: "og:description",
      content: "An excerpt.",
    });
    expect(meta).toContainEqual({ property: "og:type", content: "article" });
  });

  it("falls back to this page when the record composes no URL and has no home elsewhere", () => {
    const head = documentHead({
      ...loaderData,
      doc: { title: "No path" },
      ident: "Writer.Example",
      canonicalUrl: null,
    });
    const url = "https://trygoldroad.com/@writer.example/3abc2345678df";
    expect(head.links).toContainEqual({ rel: "canonical", href: url });
    expect(head.meta).toContainEqual({ property: "og:url", content: url });
  });

  it("omits canonical/og:url (never guesses) when the home is another site", () => {
    const head = documentHead({
      ...loaderData,
      doc: { title: "Elsewhere", site: "https://writer.leaflet.pub" },
      canonicalUrl: null,
    });
    expect(head.links?.some((l) => l.rel === "canonical")).toBe(false);
    expect(
      head.meta?.some((m) => "property" in m && m.property === "og:url"),
    ).toBe(false);
    // The AT-URI tags survive — the record reference doesn't depend on a URL.
    expect(head.links).toContainEqual({
      rel: "site.standard.document",
      href: loaderData.atUri,
    });
  });

  it("moves a URL minted on a legacy origin onto the canonical one", () => {
    const head = documentHead({
      ...loaderData,
      canonicalUrl:
        "https://goldroad.kibuchi.workers.dev/@writer.example/3abc2345678df",
    });
    expect(head.links).toContainEqual({
      rel: "canonical",
      href: "https://trygoldroad.com/@writer.example/3abc2345678df",
    });
  });

  it("emits an absolute canonical-origin og:image through /img when a cover exists", () => {
    const { meta } = documentHead({
      ...loaderData,
      cover: {
        did: "did:plc:fake0000000000writer0000",
        cid: "bafkreicanarycovercid000000000000000000000",
      },
    });
    expect(meta).toContainEqual({
      property: "og:image",
      content:
        "https://trygoldroad.com/img/did%3Aplc%3Afake0000000000writer0000/bafkreicanarycovercid000000000000000000000",
    });
  });

  it("emits no og:image without a cover", () => {
    const { meta } = documentHead(loaderData);
    expect(
      meta?.some((m) => "property" in m && m.property === "og:image"),
    ).toBe(false);
  });

  it("advertises the publication's RSS feed from the canonical origin", () => {
    const { links } = documentHead(loaderData);
    expect(links).toContainEqual({
      rel: "alternate",
      type: "application/rss+xml",
      title: "@writer.example — RSS",
      href: "https://trygoldroad.com/@writer.example/rss.xml",
    });
  });
});

/**
 * Mirrored posts (import ledger): the reader page must swap its canonical
 * tag for noindex — search engines index the ORIGINAL, not our copy — while
 * the at:// record tags stay (interop, not SEO).
 */
describe("documentHead — mirrored posts", () => {
  const loaderData = {
    doc: { title: "Mirrored", site: "https://goldroad.example/@w" },
    ident: "writer.example",
    atUri:
      "at://did:plc:fake0000000000writer0000/site.standard.document/3abc2345678df",
    canonicalUrl: "https://goldroad.example/@writer.example/3abc2345678df",
    mirror: {
      sourceUrl: "https://writer.substack.com/p/mirrored",
      kind: "feed" as const,
    },
  };

  it("swaps the canonical link for robots noindex", () => {
    const head = documentHead(loaderData);
    expect(head.meta).toContainEqual({ name: "robots", content: "noindex" });
    expect(head.links?.some((l) => l.rel === "canonical")).toBe(false);
  });

  it("keeps the at:// record link tags (interop is not SEO)", () => {
    const { links } = documentHead(loaderData);
    expect(links).toContainEqual({
      rel: "site.standard.document",
      href: loaderData.atUri,
    });
    expect(links).toContainEqual({ rel: "alternate", href: loaderData.atUri });
  });

  it("adopted/native posts (mirror null) keep the canonical, no noindex", () => {
    const head = documentHead({ ...loaderData, mirror: null });
    expect(head.links).toContainEqual({
      rel: "canonical",
      href: loaderData.canonicalUrl,
    });
    expect(head.meta?.some((m) => "name" in m && m.name === "robots")).toBe(
      false,
    );
  });
});

/**
 * schema.org Article structured data — the route's actual wiring (see
 * ~/lib/json-ld for the builder/escaping unit tests). Pins the field
 * mapping and the fallback when no publication record was resolved.
 */
describe("documentHead — JSON-LD Article script", () => {
  const loaderData = {
    doc: {
      title: "Hello Atmosphere",
      description: "An excerpt.",
      site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
      path: "/3abc2345678df",
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
    ident: "writer.example",
    atUri:
      "at://did:plc:fake0000000000writer0000/site.standard.document/3abc2345678df",
    canonicalUrl: "https://goldroad.example/@writer.example/3abc2345678df",
    publicationName: "The Long Way",
  };

  it("emits a single application/ld+json script with the Article shape", () => {
    const { scripts } = documentHead(loaderData);
    expect(scripts).toHaveLength(1);
    const script = scripts?.[0];
    // FLAT props, as this router renders them. The previous shape here was
    // `{ tag, attrs, children }`, which the router spread onto the element as
    // literal attributes — so the tag shipped without `type`, browsers parsed
    // the JSON-LD as JavaScript and threw on every document page, and search
    // engines saw no structured data at all. This test asserted that broken
    // object and passed, which is the lesson: assert what reaches the browser.
    expect(script?.type).toBe("application/ld+json");
    expect(script).not.toHaveProperty("tag");
    expect(script).not.toHaveProperty("attrs");
    const jsonLd = JSON.parse(script?.children ?? "{}");
    expect(jsonLd).toMatchObject({
      "@type": "Article",
      headline: "Hello Atmosphere",
      datePublished: "2026-01-01T00:00:00.000Z",
      author: { name: "writer.example" },
      publisher: { name: "The Long Way" },
      url: loaderData.canonicalUrl,
    });
  });

  it("falls back the publisher to the handle when no publication record was resolved", () => {
    const { scripts } = documentHead({ ...loaderData, publicationName: null });
    const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
    // No record URL either, so both point at the writer's page here.
    expect(jsonLd.publisher).toEqual({
      "@type": "Organization",
      name: "writer.example",
      url: "https://trygoldroad.com/@writer.example",
    });
    expect(jsonLd.author).toEqual({
      "@type": "Person",
      name: "writer.example",
      url: "https://trygoldroad.com/@writer.example",
      sameAs: ["https://bsky.app/profile/writer.example"],
    });
  });

  it("links the author and publisher to the publication, with its icon as the logo", () => {
    const { scripts } = documentHead({
      ...loaderData,
      publicationUrl: "https://writer.leaflet.pub",
      publicationIcon: {
        did: "did:plc:fake0000000000writer0000",
        cid: "bafkreiicon",
      },
    });
    const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
    expect(jsonLd.author.url).toBe("https://writer.leaflet.pub");
    expect(jsonLd.publisher).toEqual({
      "@type": "Organization",
      name: "The Long Way",
      url: "https://writer.leaflet.pub",
      logo: {
        "@type": "ImageObject",
        url: "https://trygoldroad.com/img/did%3Aplc%3Afake0000000000writer0000/bafkreiicon",
      },
    });
    expect(jsonLd.description).toBe("An excerpt.");
    // The record carries no updatedAt, so no edit date is claimed.
    expect(jsonLd.dateModified).toBeUndefined();
    expect(jsonLd.mainEntityOfPage).toBe(loaderData.canonicalUrl);
  });

  it("names our page as the writer's home when the record's url won't do", () => {
    for (const publicationUrl of [
      "https://",
      "https://writer.example/?utm=1",
      "https://writer.example/#top",
      "https://a b.example",
      "javascript:alert(1)",
      "http://writer.example",
    ]) {
      const { scripts } = documentHead({ ...loaderData, publicationUrl });
      const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
      expect(jsonLd.author.url, publicationUrl).toBe(
        "https://trygoldroad.com/@writer.example",
      );
    }
  });

  it("takes a loose document's own https site as the writer's home", () => {
    const { scripts } = documentHead({
      ...loaderData,
      doc: { ...loaderData.doc, site: "https://writer.example/" },
    });
    const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
    expect(jsonLd.author.url).toBe("https://writer.example");
  });

  it("claims no image without a cover, and describes the default card instead", () => {
    const { scripts, meta } = documentHead(loaderData);
    const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
    // A Goldroad card is not this writer's picture.
    expect(jsonLd.image).toBeUndefined();
    expect(meta).toContainEqual({
      property: "og:image:width",
      content: "1200",
    });
    expect(
      meta?.some((m) => "property" in m && m.property === "og:image:alt"),
    ).toBe(true);
  });

  it("does not call a mirror the article's main page", () => {
    const { scripts } = documentHead({
      ...loaderData,
      mirror: {
        sourceUrl: "https://writer.substack.com/p/hello",
        kind: "feed",
      },
    });
    const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
    expect(jsonLd.mainEntityOfPage).toBeUndefined();
  });

  it("includes the same absolute cover-image URL used for og:image", () => {
    const cover = {
      did: "did:plc:fake0000000000writer0000",
      cid: "bafkreicanarycovercid000000000000000000000",
    };
    const { scripts } = documentHead({ ...loaderData, cover });
    const jsonLd = JSON.parse(scripts?.[0]?.children ?? "{}");
    expect(jsonLd.image).toBe(
      "https://trygoldroad.com/img/did%3Aplc%3Afake0000000000writer0000/bafkreicanarycovercid000000000000000000000",
    );
  });
});

describe("isHiddenNotFound — takedown marker on a thrown notFound", () => {
  it("is true only for a { hidden: true } payload", () => {
    expect(isHiddenNotFound({ hidden: true })).toBe(true);
  });

  it("is false for a plain not-found (no marker)", () => {
    expect(isHiddenNotFound(undefined)).toBe(false);
    expect(isHiddenNotFound({})).toBe(false);
    expect(isHiddenNotFound({ hidden: false })).toBe(false);
    expect(isHiddenNotFound("hidden")).toBe(false);
  });
});

describe("documentHead — the link preview", () => {
  const loaderData = {
    doc: {
      title: "Hello Atmosphere",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
    },
    ident: "writer.example",
    atUri:
      "at://did:plc:fake0000000000writer0000/site.standard.document/3abc2345678df",
    canonicalUrl: "https://trygoldroad.com/@writer.example/3abc2345678df",
    publicationName: "The Long Way",
  };
  const did = "did:plc:fake0000000000writer0000";
  const cover = { did, cid: "bafkreicanarycovercid000000000000000000000" };
  const shareCard = { did, cid: "bafkreicanarysharecard0000000000000000000" };
  type Tag = { property?: string; name?: string; content?: string };
  const content = (meta: object[] = [], key: string) =>
    (meta as Tag[])
      .filter((m) => m.property === key || m.name === key)
      .map((m) => m.content);

  it("names the writer's publication as the site", () => {
    const { meta } = documentHead(loaderData);
    expect(content(meta, "og:site_name")).toEqual(["The Long Way"]);
    expect(
      content(
        documentHead({ ...loaderData, publicationName: null }).meta,
        "og:site_name",
      ),
    ).toEqual(["writer.example"]);
  });

  it("carries the record's dates as article tags, strings only", () => {
    const { meta } = documentHead(loaderData);
    expect(content(meta, "article:published_time")).toEqual([
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(content(meta, "article:modified_time")).toEqual([
      "2026-01-05T00:00:00.000Z",
    ]);
    for (const publishedAt of [42 as unknown as string, "", "yesterday"]) {
      const untrusted = documentHead({
        ...loaderData,
        doc: { title: "Odd", publishedAt },
      });
      expect(content(untrusted.meta, "article:published_time")).toEqual([]);
    }
  });

  it("leads with the share card, sized and described, ahead of the cover", () => {
    const { meta, scripts } = documentHead({ ...loaderData, cover, shareCard });
    expect(content(meta, "og:image")).toEqual([
      `https://trygoldroad.com/img/did%3Aplc%3Afake0000000000writer0000/${shareCard.cid}`,
    ]);
    expect(content(meta, "og:image:width")).toEqual(["1200"]);
    expect(content(meta, "og:image:height")).toEqual(["630"]);
    const alt = '"Hello Atmosphere", in The Long Way, by writer.example';
    expect(content(meta, "og:image:alt")).toEqual([alt]);
    expect(content(meta, "twitter:image:alt")).toEqual([alt]);
    // The Article's image stays the writer's own picture.
    expect(JSON.parse(scripts?.[0]?.children ?? "{}").image).toBe(
      `https://trygoldroad.com/img/did%3Aplc%3Afake0000000000writer0000/${cover.cid}`,
    );
  });

  it("describes the default card to X too when there is no picture", () => {
    const { meta } = documentHead(loaderData);
    expect(content(meta, "twitter:image:alt")).toEqual(
      content(meta, "og:image:alt"),
    );
    expect(content(meta, "twitter:image:alt")).toHaveLength(1);
  });

  it("describes a cover under both alt names, with no size it doesn't know", () => {
    const { meta } = documentHead({ ...loaderData, cover });
    expect(content(meta, "og:image:width")).toEqual([]);
    expect(content(meta, "twitter:image:alt")).toEqual([
      'Cover image for "Hello Atmosphere"',
    ]);
  });
});
