/**
 * schema.org Article structured data for document pages. Minimal, honest
 * fields only — never invent a claim the record doesn't carry.
 */

type Organization = {
  "@type": "Organization";
  name: string;
  url?: string;
  logo?: { "@type": "ImageObject"; url: string };
};

export type ArticleJsonLd = {
  "@context": "https://schema.org";
  "@type": "Article";
  headline: string;
  description?: string;
  datePublished?: string;
  dateModified?: string;
  author: { "@type": "Person"; name: string; url: string; sameAs?: string[] };
  publisher: Organization;
  url?: string;
  mainEntityOfPage?: string;
  image?: string;
};

export function buildArticleJsonLd(input: {
  headline: string;
  description?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  /** The writer's handle — every document has one; there's no display-name
   * field on the record, so the handle IS the byline. */
  authorName: string;
  /** The writer's home on the web: their publication's own URL when the record
   * names one, else their page here. */
  authorUrl: string;
  /** Other pages that are the same person (their Bluesky profile). */
  authorSameAs?: string[];
  /** Publication name when known, else falls back to the author's handle
   * (mirrors the footer's own "More from …" fallback). */
  publisherName: string;
  publisherUrl?: string | null;
  /** The publication's icon, absolute, when it has one. */
  publisherLogoUrl?: string | null;
  url?: string | null;
  imageUrl?: string | null;
}): ArticleJsonLd {
  const publisher: Organization = {
    "@type": "Organization",
    name: input.publisherName,
  };
  if (input.publisherUrl) publisher.url = input.publisherUrl;
  if (input.publisherLogoUrl)
    publisher.logo = { "@type": "ImageObject", url: input.publisherLogoUrl };
  const jsonLd: ArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    author: { "@type": "Person", name: input.authorName, url: input.authorUrl },
    publisher,
  };
  if (input.authorSameAs?.length) jsonLd.author.sameAs = input.authorSameAs;
  if (input.description) jsonLd.description = input.description;
  if (input.publishedAt) jsonLd.datePublished = input.publishedAt;
  // Always alongside datePublished, as search engines ask: a post never
  // edited was last modified when it was published.
  const modified = input.updatedAt || input.publishedAt;
  if (modified) jsonLd.dateModified = modified;
  if (input.url) {
    jsonLd.url = input.url;
    jsonLd.mainEntityOfPage = input.url;
  }
  if (input.imageUrl) jsonLd.image = input.imageUrl;
  return jsonLd;
}

/**
 * Serializes JSON-LD for embedding in a `<script type="application/ld+json">`
 * element. Every `<` is escaped to its unicode form: this payload carries
 * arbitrary third-party strings (a writer's title, a publication's name),
 * and escaping `<` means the output contains zero literal `<` characters —
 * no substring can ever open a tag or close the surrounding `<script>`
 * element, even if some downstream consumer re-parses this as raw HTML.
 * (`<` doesn't need escaping for JSON validity — `JSON.parse` decodes
 * `<` back to `<` exactly like a literal one, so nothing is lost.)
 *
 * This is the same pattern TanStack Router's own `<Script>` component uses
 * to render `application/ld+json` data scripts. dangerouslySetInnerHTML is
 * kept to output that is safe by construction (this, and the reader body from
 * ~/lib/markdown-html). There is no markup here at all after this escape: a
 * data blob, not rendered content.
 */
export function jsonLdScriptContent(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
