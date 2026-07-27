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
