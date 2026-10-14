/**
 * The publications this instance hosts (the `hosted_publications` table):
 * noted whenever a post is published through Goldroad, read by /sitemap.xml.
 * The reading surfaces render any atproto author's records, so a complete list
 * is impossible; the writers who publish HERE are the part we can vouch for.
 */
import { desc, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { hiddenContent, hostedPublications } from "~/db/schema";
import { CANONICAL_ORIGIN, LEGACY_ORIGINS } from "~/lib/origin";
import { isOwnPublicationUrl } from "~/lib/publish";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Upserts the writer's publication. Callers treat it as best-effort: a
 * missed row costs a sitemap line, never a publish. */
export function recordHostedPublication(
  db: DrizzleD1,
  did: string,
  url: string,
) {
  const updatedAt = new Date();
  return db
    .insert(hostedPublications)
    .values({ did, url, updatedAt })
    .onConflictDoUpdate({
      target: hostedPublications.did,
      set: { url, updatedAt },
    });
}

/** Rows one sitemap response reads. The protocol allows 50,000 URLs per file;
 * this keeps the D1 read and the response small long before that matters. */
export const MAX_SITEMAP_PUBLICATIONS = 5_000;

/** The sitemap's publications, most recently published first, leaving out any
 * writer on the takedown list (an author-level row is keyed on the bare DID). */
export function selectSitemapPublications(db: DrizzleD1) {
  return db
    .select({
      url: hostedPublications.url,
      updatedAt: hostedPublications.updatedAt,
    })
    .from(hostedPublications)
    .where(
      sql`${hostedPublications.did} not in (select ${hiddenContent.subject} from ${hiddenContent})`,
    )
    .orderBy(desc(hostedPublications.updatedAt))
    .limit(MAX_SITEMAP_PUBLICATIONS);
}

/** A stored publication url as the sitemap lists it: on the canonical origin,
 * path only. Records written before the move to the canonical domain carry the
 * legacy host, which 301s here anyway. Null for anything that isn't ours. */
export function sitemapPublicationUrl(url: string): string | null {
  if (!isOwnPublicationUrl(url, [CANONICAL_ORIGIN, ...LEGACY_ORIGINS]))
    return null;
  try {
    return `${CANONICAL_ORIGIN}${new URL(url).pathname}`;
  } catch {
    return null;
  }
}
