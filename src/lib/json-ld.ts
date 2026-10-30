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

const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

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
  /** The page this Article is the main subject of. Absent on a mirror, whose
   * original lives elsewhere. */
  mainEntityOfPage?: string | null;
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
  // Record fields are untrusted: only strings make it in.
  if (isText(input.description)) jsonLd.description = input.description;
  if (isText(input.publishedAt)) jsonLd.datePublished = input.publishedAt;
  // Only what the record says. A record without updatedAt doesn't say it was
  // never edited, so the publish date isn't offered in its place.
  if (isText(input.updatedAt)) jsonLd.dateModified = input.updatedAt;
  if (input.url) jsonLd.url = input.url;
  if (input.mainEntityOfPage) jsonLd.mainEntityOfPage = input.mainEntityOfPage;
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

export type ProfilePageJsonLd = {
  "@context": "https://schema.org";
  "@type": "ProfilePage";
  name: string;
  description?: string;
  mainEntity: {
    "@type": "Person";
    name: string;
    url: string;
    sameAs: string[];
  };
};

/**
 * schema.org ProfilePage for a publication's archive: one writer's page of
 * their posts, which is what Google's profile-page markup describes. The
 * Person is the writer, named by handle for the same reason as an Article's
 * byline; the page's name is the publication's.
 */
export function buildProfilePageJsonLd(input: {
  /** The publication's name, else the writer's handle. */
  name: string;
  description?: string | null;
  authorName: string;
  /** The writer's home on the web (see buildArticleJsonLd's authorUrl). */
  authorUrl: string;
  /** Other pages that are the same person (their Bluesky profile). */
  authorSameAs: string[];
}): ProfilePageJsonLd {
  const jsonLd: ProfilePageJsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    name: input.name,
    mainEntity: {
      "@type": "Person",
      name: input.authorName,
      url: input.authorUrl,
      sameAs: input.authorSameAs,
    },
  };
  if (isText(input.description)) jsonLd.description = input.description;
  return jsonLd;
}

/**
 * schema.org WebSite and Organization for the front page. Google reads the
 * WebSite's name as the site name it prints above every result from this
 * origin, and the Organization's logo as the one it may show beside them. The
 * logo is the 512px app icon, square and well above Google's 112px minimum.
 */
export function buildSiteJsonLd(input: { name: string; origin: string }) {
  const url = `${input.origin}/`;
  const organization = `${url}#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${url}#website`,
        name: input.name,
        url,
        publisher: { "@id": organization },
      },
      {
        "@type": "Organization",
        "@id": organization,
        name: input.name,
        url,
        logo: `${input.origin}/logo512.png`,
      },
    ],
  };
}
