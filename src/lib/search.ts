/**
 * Full-text search over a Goldroad writer's own posts, in D1's FTS5 (see
 * `searchDocuments` in ~/db/schema for the tables and why the index is
 * external-content).
 *
 * WHAT IS INDEXED: the documents this app writes, as it writes them (publish,
 * edit, delete, in ~/routes/api.publish and ~/lib/publish-document), plus a
 * one-off backfill of each writer's existing posts (/api/search/backfill).
 * A document carrying content we can't round-trip (another app's format) is
 * left out, the same line the editor draws: we don't see that app's edits, so
 * an index of it would go stale without anyone knowing.
 *
 * OTHER AUTHORS ARE NOT INDEXED, AT ALL. Their archives render here, but
 * indexing them would mean reading a whole repo on a stranger's say-so (one
 * search on any atproto handle would start it), keeping it current with no
 * signal when they edit or delete, and spending the free plan's 100,000 D1
 * rows written a day on people who never signed up: FTS5 writes several index
 * rows per document. Their archives keep the title-and-summary filter over the
 * posts the page already loaded, and the page says so.
 *
 * Search answers from the index only once a writer's backfill has finished
 * (`searchBackfills`), so a search can't silently miss their older posts.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { searchBackfills, searchDocuments } from "~/db/schema";
import { parseAtUri } from "~/lib/atproto";
import {
  documentBodyMarkdown,
  hasForeignContent,
} from "~/lib/document-content";
import { plainTextBody } from "~/lib/feed";
import { hiddenSubjects, recordAtUri } from "~/lib/moderation";
import { MAX_BODY_LENGTH } from "~/lib/publish";
import {
  normalizeQuery,
  toMatchExpression,
  withoutHitMarkers,
} from "~/lib/search-query";
import { env } from "cloudflare:workers";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Results one search shows. Ranked, so the first page is the useful one. */
export const SEARCH_RESULT_LIMIT = 20;

/** Records one backfill call reads. Small on purpose: each is parsed on a
 * 10 ms CPU budget, and a long post's record runs to hundreds of KB. */
export const BACKFILL_PAGE_SIZE = 20;

/** The document fields search reads. Structural, so a record value read from
 * a PDS and one this app just built both fit. */
type SearchableRecord = {
  title?: unknown;
  description?: unknown;
  textContent?: unknown;
  content?: unknown;
  publishedAt?: unknown;
};

/**
 * What a document contributes to the index, or null when it shouldn't be in
 * it (another app's content, or no title to show in a result).
 *
 * The body is the record's own `textContent` when it carries markpub content,
 * because that is the plaintext the publish path already produced. Anything
 * else (an older record keeping markdown in `textContent`) is reduced to
 * plaintext here, so markup never turns into search terms.
 */
export function searchableText(record: SearchableRecord) {
  if (hasForeignContent(record)) return null;
  if (typeof record.title !== "string" || !record.title.trim()) return null;
  const body =
    record.content != null && typeof record.textContent === "string"
      ? record.textContent
      : plainTextBody(documentBodyMarkdown(record), MAX_BODY_LENGTH);
  return {
    title: withoutHitMarkers(record.title),
    description:
      typeof record.description === "string"
        ? withoutHitMarkers(record.description)
        : "",
    body: withoutHitMarkers(body),
    publishedAt:
      typeof record.publishedAt === "string" ? record.publishedAt : null,
  };
}

/** The statement that puts one document in the index, replacing what was
 * there. The triggers on `search_documents` keep FTS5 in step. */
function upsertStatement(
  db: DrizzleD1,
  did: string,
  rkey: string,
  text: NonNullable<ReturnType<typeof searchableText>>,
) {
  return db
    .insert(searchDocuments)
    .values({ did, rkey, ...text })
    .onConflictDoUpdate({
      target: [searchDocuments.did, searchDocuments.rkey],
      set: text,
    });
}

function deleteStatement(db: DrizzleD1, did: string, rkey: string) {
  return db
    .delete(searchDocuments)
    .where(and(eq(searchDocuments.did, did), eq(searchDocuments.rkey, rkey)));
}

/**
 * Brings the index in line with a document that was just written. A record
 * that shouldn't be searchable is removed rather than skipped, so an edit
 * that took a post out of scope doesn't leave its old text findable.
 *
 * Callers treat this as best-effort, after the record is live: a flaked index
 * write costs that post's findability until it is next edited, never the
 * publish.
 */
export async function indexDocument(
  db: DrizzleD1,
  did: string,
  rkey: string,
  record: SearchableRecord,
): Promise<void> {
  const text = searchableText(record);
  await (text
    ? upsertStatement(db, did, rkey, text)
    : deleteStatement(db, did, rkey));
}

/** Takes a deleted document out of the index. */
export async function unindexDocument(
  db: DrizzleD1,
  did: string,
  rkey: string,
): Promise<void> {
  await deleteStatement(db, did, rkey);
}

/** A page of the writer's documents, as ~/lib/atproto's listRecordsPage
 * answers. Injected so the backfill is testable without a PDS. */
export type DocumentPage = {
  records: { uri: string; value: SearchableRecord }[];
  cursor: string | null;
};

/**
 * One step of a writer's backfill: the next page of their documents into the
 * index, and the cursor saved so the next call carries on. Idempotent, so two
 * tabs running it at once only repeat work. `done` once a page comes back
 * without a cursor, and from then on search answers from the index.
 */
export async function backfillStep(
  db: DrizzleD1,
  did: string,
  readPage: (cursor: string | undefined) => Promise<DocumentPage>,
  now: Date = new Date(),
): Promise<{ done: boolean; indexed: number }> {
  const [state] = await db
    .select()
    .from(searchBackfills)
    .where(eq(searchBackfills.did, did))
    .limit(1);
  if (state?.completedAt) return { done: true, indexed: 0 };

  const page = await readPage(state?.cursor ?? undefined);
  const upserts = page.records.flatMap((record) => {
    // The listing is the writer's own repo, but it is still network data:
    // only a document key in that repo is ever written under their DID.
    const at = parseAtUri(record.uri);
    const text = searchableText(record.value);
    return at?.did === did && at.collection === "site.standard.document" && text
      ? [upsertStatement(db, did, at.rkey, text)]
      : [];
  });
  const progress = {
    cursor: page.cursor,
    completedAt: page.cursor ? null : now,
    updatedAt: now,
  };
  await db.batch([
    db
      .insert(searchBackfills)
      .values({ did, ...progress })
      .onConflictDoUpdate({ target: searchBackfills.did, set: progress }),
    ...upserts,
  ]);
  return { done: page.cursor === null, indexed: upserts.length };
}

export type SearchHit = {
  rkey: string;
  /** The title with matched words between HIT_OPEN/HIT_CLOSE. */
  title: string;
  /** A stretch of the body around the matches, marked the same way. */
  snippet: string;
  description: string;
  publishedAt: string | null;
};

/** The ranked matches for one writer. Title matches weigh most, then the
 * summary, then the body. One more row than is shown, to know there are
 * more. */
export async function searchPosts(
  db: DrizzleD1,
  did: string,
  match: string,
  limit: number = SEARCH_RESULT_LIMIT,
): Promise<SearchHit[]> {
  return db.all<SearchHit>(sql`
    select d.rkey as rkey,
      highlight(post_search, 0, char(2), char(3)) as title,
      snippet(post_search, 2, char(2), char(3), '…', 24) as snippet,
      d.description as description,
      d.published_at as publishedAt
    from post_search
    join search_documents d on d.id = post_search.rowid
    where post_search match ${match} and d.did = ${did}
    order by bm25(post_search, 10.0, 4.0, 1.0)
    limit ${limit + 1}`);
}

/** Is this writer's index complete enough to answer from? */
export async function isSearchReady(
  db: DrizzleD1,
  did: string,
): Promise<boolean> {
  const [row] = await db
    .select({ completedAt: searchBackfills.completedAt })
    .from(searchBackfills)
    .where(eq(searchBackfills.did, did))
    .limit(1);
  return row?.completedAt != null;
}

export type PublicationSearch =
  /** No index to answer from: the page filters what it loaded instead. */
  { ready: false } | { ready: true; hits: SearchHit[]; more: boolean };

/**
 * The archive's search, in full: is there an index, what matches, and which
 * of those are taken down. Fails to `ready: false` on a D1 error, which is the
 * title filter: a worse search, but a page that still answers.
 */
export async function runPublicationSearch(
  db: DrizzleD1,
  did: string,
  q: string,
): Promise<PublicationSearch> {
  const match = toMatchExpression(q);
  if (!did || !match) return { ready: false };
  try {
    if (!(await isSearchReady(db, did))) return { ready: false };
    const found = await searchPosts(db, did, match);
    // Record-level takedowns. An author-level one never gets this far: the
    // loader has already answered 404.
    const uri = (hit: SearchHit) =>
      recordAtUri(did, "site.standard.document", hit.rkey);
    const hidden = await hiddenSubjects(db, found.map(uri));
    return {
      ready: true,
      hits: found
        .filter((hit) => !hidden.has(uri(hit)))
        .slice(0, SEARCH_RESULT_LIMIT),
      more: found.length > SEARCH_RESULT_LIMIT,
    };
  } catch (err) {
    console.error("post search failed", err);
    return { ready: false };
  }
}

/** runPublicationSearch as a server function, for the same reason as
 * ~/lib/moderation's checkHidden: the reader loader is isomorphic, and this
 * keeps D1 out of the client bundle. */
export const searchPublication = createServerFn({ method: "GET" })
  .validator((data: { did?: unknown; q?: unknown }) => ({
    did: typeof data?.did === "string" ? data.did : "",
    q: normalizeQuery(data?.q),
  }))
  .handler(async ({ data }): Promise<PublicationSearch> => {
    if (!env.DB) return { ready: false };
    return runPublicationSearch(drizzle(env.DB), data.did, data.q);
  });
