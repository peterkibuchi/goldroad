/**
 * The publications this instance hosts (the `hosted_publications` table):
 * noted when a post is published through Goldroad into a publication record of
 * ours, read by /sitemap.xml. The reading surfaces render any atproto author's
 * records, so a complete list is impossible; the writers who publish HERE are
 * the part we can vouch for.
 */
import { desc, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { hiddenContent, hostedPublications } from "~/db/schema";
import { isDid, isHandle } from "~/lib/atproto";
import { CANONICAL_ORIGIN } from "~/lib/origin";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Upserts the writer's row: the ident they published under, and now. */
export function recordHostedPublication(
  db: DrizzleD1,
  did: string,
  ident: string,
) {
  const updatedAt = new Date();
  return db
    .insert(hostedPublications)
    .values({ did, ident, updatedAt })
    .onConflictDoUpdate({
      target: hostedPublications.did,
      set: { ident, updatedAt },
    });
}

/**
 * After a post lands: note the writer's publication if the post went into a
 * publication record of ours, which is exactly when its `site` is an at:// URI
 * (resolvePublicationSite answers with the https fallback otherwise). Never
 * throws: a missed row costs a sitemap line, never a publish.
 */
export async function noteHostedPublication(
  db: DrizzleD1,
  did: string,
  ident: string,
  site: string,
): Promise<void> {
  if (!site.startsWith("at://")) return;
  if (!isHandle(ident) && !isDid(ident)) return;
  await recordHostedPublication(db, did, ident).catch((err: unknown) => {
    console.warn("hosted-publication note failed", err);
  });
}

/** Rows one sitemap response reads, newest first, along an index. Bounded by
 * the free tier rather than the protocol's 50,000: each response is one D1
 * read of this many rows and a string join, well inside 10 ms of CPU. */
export const MAX_SITEMAP_PUBLICATIONS = 1_000;

/** The sitemap's publications, leaving out any writer on the takedown list
 * (an author-level row is keyed on the bare DID). A record-level takedown
 * hides one post, not the publication page, which is what the archive's own
 * check does too. */
export function selectSitemapPublications(db: DrizzleD1) {
  return db
    .select({
      ident: hostedPublications.ident,
      updatedAt: hostedPublications.updatedAt,
    })
    .from(hostedPublications)
    .where(
      sql`${hostedPublications.did} not in (select ${hiddenContent.subject} from ${hiddenContent})`,
    )
    .orderBy(desc(hostedPublications.updatedAt))
    .limit(MAX_SITEMAP_PUBLICATIONS);
}

/** A writer's publication page here, or null for a stored ident that isn't a
 * valid handle or DID. Built from the ident alone, never from a record's url,
 * so nothing a writer's repo says can point the sitemap anywhere else. */
export function sitemapPublicationUrl(ident: string): string | null {
  if (!isHandle(ident) && !isDid(ident)) return null;
  return `${CANONICAL_ORIGIN}/@${encodeURIComponent(ident)}`;
}
