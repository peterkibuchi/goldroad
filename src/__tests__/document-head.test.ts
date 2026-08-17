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

  it("omits canonical/og:url (never guesses) when composition failed", () => {
    const head = documentHead({ ...loaderData, canonicalUrl: null });
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
    expect(jsonLd.publisher).toEqual({
      "@type": "Organization",
      name: "writer.example",
    });
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
