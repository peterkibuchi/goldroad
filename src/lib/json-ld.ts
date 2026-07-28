/**
 * schema.org Article structured data for document pages. Minimal, honest
 * fields only — never invent a claim the record doesn't carry.
 */

export type ArticleJsonLd = {
  "@context": "https://schema.org";
  "@type": "Article";
  headline: string;
  datePublished?: string;
  dateModified?: string;
  author: { "@type": "Person"; name: string };
  publisher: { "@type": "Organization"; name: string };
  url?: string;
  image?: string;
};

export function buildArticleJsonLd(input: {
  headline: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  /** The writer's handle — every document has one; there's no display-name
   * field on the record, so the handle IS the byline. */
  authorName: string;
  /** Publication name when known, else falls back to the author's handle
   * (mirrors the footer's own "More from …" fallback). */
  publisherName: string;
  url?: string | null;
  imageUrl?: string | null;
}): ArticleJsonLd {
  const jsonLd: ArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    author: { "@type": "Person", name: input.authorName },
    publisher: { "@type": "Organization", name: input.publisherName },
  };
  if (input.publishedAt) jsonLd.datePublished = input.publishedAt;
  if (input.updatedAt && input.updatedAt !== input.publishedAt) {
    jsonLd.dateModified = input.updatedAt;
  }
  if (input.url) jsonLd.url = input.url;
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
 * to render `application/ld+json` data scripts — the one narrow, justified
 * exception to this codebase's "no dangerouslySetInnerHTML" rule, which
 * exists to keep arbitrary third-party HTML/markdown inert. There is no
 * markup here at all after this escape: a data blob, not rendered content.
 */
export function jsonLdScriptContent(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
