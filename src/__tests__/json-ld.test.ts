// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  buildArticleJsonLd,
  buildProfilePageJsonLd,
  buildSiteJsonLd,
  jsonLdScriptContent,
} from "../lib/json-ld";

describe("buildArticleJsonLd", () => {
  it("emits the required schema.org Article shape", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "Hello Atmosphere",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "The Long Way",
      url: "https://trygoldroad.com/@writer.example/3abc2345678df",
      imageUrl: null,
    });
    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Hello Atmosphere",
      datePublished: "2026-01-01T00:00:00.000Z",
      author: { "@type": "Person", name: "writer.example" },
      publisher: { "@type": "Organization", name: "The Long Way" },
      url: "https://trygoldroad.com/@writer.example/3abc2345678df",
    });
    // The record's own updatedAt, even when it equals the publish date.
    expect(jsonLd.dateModified).toBe("2026-01-01T00:00:00.000Z");
    expect(jsonLd.image).toBeUndefined();
  });

  it("carries the edit date when there is one", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "Edited",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "writer.example",
    });
    expect(jsonLd.dateModified).toBe("2026-01-05T00:00:00.000Z");
  });

  it("links the author and the publication to their homes", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "Linked",
      description: "The dek.",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      authorSameAs: ["https://bsky.app/profile/writer.example"],
      publisherName: "The Long Way",
      publisherUrl: "https://trygoldroad.com/@writer.example",
      publisherLogoUrl: "https://trygoldroad.com/img/did%3Aplc%3Ax/bafkreiicon",
      url: "https://trygoldroad.com/@writer.example/3abc2345678df",
      mainEntityOfPage: "https://trygoldroad.com/@writer.example/3abc2345678df",
    });
    expect(jsonLd).toMatchObject({
      description: "The dek.",
      author: {
        "@type": "Person",
        name: "writer.example",
        url: "https://trygoldroad.com/@writer.example",
        sameAs: ["https://bsky.app/profile/writer.example"],
      },
      publisher: {
        "@type": "Organization",
        name: "The Long Way",
        url: "https://trygoldroad.com/@writer.example",
        logo: {
          "@type": "ImageObject",
          url: "https://trygoldroad.com/img/did%3Aplc%3Ax/bafkreiicon",
        },
      },
      mainEntityOfPage: "https://trygoldroad.com/@writer.example/3abc2345678df",
    });
  });

  it("claims no edit date the record doesn't carry, and takes only strings", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "Untrusted fields",
      // A record from another app, typed loosely on the wire.
      description: { not: "a string" } as unknown as string,
      publishedAt: "2026-01-01T00:00:00.000Z",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "writer.example",
    });
    expect(jsonLd.dateModified).toBeUndefined();
    expect(jsonLd.description).toBeUndefined();
  });

  it("falls back the publisher to the author's handle when no publication name is known", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "No publication record",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "writer.example",
    });
    expect(jsonLd.publisher).toEqual({
      "@type": "Organization",
      name: "writer.example",
    });
  });

  it("includes the cover image URL when one is provided", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "With a cover",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "writer.example",
      imageUrl: "https://trygoldroad.com/img/did%3Aplc%3Afake/bafkreicover",
    });
    expect(jsonLd.image).toBe(
      "https://trygoldroad.com/img/did%3Aplc%3Afake/bafkreicover",
    );
  });
});

describe("jsonLdScriptContent — rendered <script> tag safety", () => {
  it("round-trips through an actual DOM <script> element", () => {
    const jsonLd = buildArticleJsonLd({
      headline: "Hello Atmosphere",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "The Long Way",
    });
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.textContent = jsonLdScriptContent(jsonLd);
    document.body.appendChild(script);

    const found = document.querySelector('script[type="application/ld+json"]');
    expect(found).not.toBeNull();
    const parsed = JSON.parse(found?.textContent ?? "{}");
    expect(parsed).toMatchObject({
      "@type": "Article",
      headline: "Hello Atmosphere",
      publisher: { name: "The Long Way" },
    });

    script.remove();
  });

  it("neutralizes a hostile title/publication name that tries to break out of the script tag", () => {
    // A malicious third-party record could carry this in its title or
    // publication name — the writer's PDS is untrusted input.
    const hostileHeadline = "</script><script>window.pwned = true;</script>";
    const jsonLd = buildArticleJsonLd({
      headline: hostileHeadline,
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      publisherName: "writer.example",
    });
    const raw = jsonLdScriptContent(jsonLd);

    // No literal '<' survives serialization — nothing can open a tag.
    expect(raw).not.toContain("<");

    const container = document.createElement("div");
    container.innerHTML = `<script type="application/ld+json">${raw}</script><p id="marker">safe</p>`;
    document.body.appendChild(container);

    // Exactly one script tag exists — the payload didn't fragment the markup.
    expect(container.querySelectorAll("script")).toHaveLength(1);
    expect(document.getElementById("marker")?.textContent).toBe("safe");
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();

    // The data still parses back to the original hostile string — inert as
    // data, not executed as markup.
    const parsed = JSON.parse(
      container.querySelector("script")?.textContent ?? "{}",
    );
    expect(parsed.headline).toBe(hostileHeadline);

    container.remove();
  });
});

describe("buildProfilePageJsonLd", () => {
  it("names the publication and the writer behind it", () => {
    expect(
      buildProfilePageJsonLd({
        name: "The Long Way",
        description: "Essays.",
        authorName: "writer.example",
        authorUrl: "https://trygoldroad.com/@writer.example",
        authorSameAs: ["https://bsky.app/profile/writer.example"],
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      name: "The Long Way",
      description: "Essays.",
      mainEntity: {
        "@type": "Person",
        name: "writer.example",
        url: "https://trygoldroad.com/@writer.example",
        sameAs: ["https://bsky.app/profile/writer.example"],
      },
    });
  });

  it("leaves out a description the record doesn't carry", () => {
    const jsonLd = buildProfilePageJsonLd({
      name: "writer.example",
      description: "",
      authorName: "writer.example",
      authorUrl: "https://trygoldroad.com/@writer.example",
      authorSameAs: [],
    });
    expect("description" in jsonLd).toBe(false);
  });
});

describe("buildSiteJsonLd", () => {
  it("links the WebSite to the Organization that publishes it", () => {
    const { "@graph": graph } = buildSiteJsonLd({
      name: "Goldroad",
      origin: "https://trygoldroad.com",
    });
    expect(graph).toEqual([
      {
        "@type": "WebSite",
        "@id": "https://trygoldroad.com/#website",
        name: "Goldroad",
        url: "https://trygoldroad.com/",
        publisher: { "@id": "https://trygoldroad.com/#organization" },
      },
      {
        "@type": "Organization",
        "@id": "https://trygoldroad.com/#organization",
        name: "Goldroad",
        url: "https://trygoldroad.com/",
        logo: "https://trygoldroad.com/logo512.png",
      },
    ]);
  });
});
