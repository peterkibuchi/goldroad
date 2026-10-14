/**
 * Full-text search over a Goldroad writer's own posts, in D1's FTS5 (see
 * `searchDocuments` in ~/db/schema for the tables and why the index is
 * external-content).
 *
 * WHAT IS INDEXED: the documents this app writes, as it writes them (publish,
 * edit, delete, in ~/routes/api.publish and ~/lib/publish-document), plus a
 * one-off backfill of each writer's existing posts (/api/search/backfill).
 * A document in another app's format, which the archive lists too, is
 * indexed by title and summary only: its body is that app's to render, and
 * the title is what the archive's old filter found it by.
 *
 * KNOWN GAP: a change made in another app after the backfill (a Goldroad post
 * deleted with a repo tool, a Leaflet post retitled) isn't seen until the post
 * is next written here. Every Goldroad path keeps the index current; a
 * periodic re-walk would close the rest, and isn't built.
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
import { anyHidden } from "~/lib/moderation";
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
 * What a document contributes to the index, or null when it has no title to
 * show in a result. Another app's content contributes its title and summary.
 *
 * The body is the record's own `textContent` when it carries markpub content,
 * because that is the plaintext the publish path already produced. Anything
 * else (an older record keeping markdown in `textContent`) is reduced to
 * plaintext here, so markup never turns into search terms.
 */
export function searchableText(record: SearchableRecord) {
  if (typeof record.title !== "string" || !record.title.trim()) return null;
  const body = hasForeignContent(record)
    ? ""
    : record.content != null && typeof record.textContent === "string"
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

/**
 * The writer as one FTS5 token: "o" and the DID's UTF-8 bytes in hex. Letters
 * and digits only, so the tokenizer can't split it, and hex, so two DIDs can
 * never share one.
 */
export function ownerToken(did: string): string {
  return `o${[...new TextEncoder().encode(did)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The statement that puts one document in the index. The triggers on
 * `search_documents` keep FTS5 in step. `replace: false` is the backfill's:
 * it never overwrites a row a publish or edit wrote since its page was read. */
function upsertStatement(
  db: DrizzleD1,
  did: string,
  rkey: string,
  text: NonNullable<ReturnType<typeof searchableText>>,
  replace = true,
) {
  const insert = db
    .insert(searchDocuments)
    .values({ did, rkey, owner: ownerToken(did), ...text });
  return replace
    ? insert.onConflictDoUpdate({
        target: [searchDocuments.did, searchDocuments.rkey],
        set: text,
      })
    : insert.onConflictDoNothing();
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
 * tabs running it at once only repeat work, and a tab finishing second can't
 * undo the first one's completion. `done` once a page comes back without a
 * cursor, and from then on search answers from the index.
 *
 * Rows already in the index are left alone: the publish and edit paths wrote
 * them, and may have done so after this page was read.
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
      ? [upsertStatement(db, did, at.rkey, text, false)]
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
      .onConflictDoUpdate({
        target: searchBackfills.did,
        set: {
          ...progress,
          completedAt: sql`coalesce(${searchBackfills.completedAt}, excluded.completed_at)`,
        },
      }),
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

/**
 * The ranked matches for one writer. Title matches weigh most, then the
 * summary, then the body. One more row than is shown, to know there are more.
 *
 * The owner token goes into the MATCH rather than a WHERE on the join: that
 * way FTS5 intersects the query with this writer's postings, and only their
 * matches are ever joined, so a search costs rows read in proportion to one
 * writer's archive, not everyone's. The query words are confined to the text
 * columns, so none of them can match an owner token.
 *
 * Posts taken down one at a time are left out here, before the limit, so a
 * run of hidden matches can't use up the page and hide visible ones behind
 * it. `hidden_content.subject` is unique, so each check is one index probe.
 */
export async function searchPosts(
  db: DrizzleD1,
  did: string,
  match: string,
  limit: number = SEARCH_RESULT_LIMIT,
): Promise<SearchHit[]> {
  const scoped = `owner:"${ownerToken(did)}" AND {title description body}: (${match})`;
  return db.all<SearchHit>(sql`
    select d.rkey as rkey,
      highlight(post_search, 1, char(2), char(3)) as title,
      snippet(post_search, 3, char(2), char(3), '…', 24) as snippet,
      d.description as description,
      d.published_at as publishedAt
    from post_search
    join search_documents d on d.id = post_search.rowid
    where post_search match ${scoped} and d.did = ${did}
      and not exists (
        select 1 from hidden_content h
        where h.subject = 'at://' || d.did || '/site.standard.document/' || d.rkey
      )
    order by bm25(post_search, 0.0, 10.0, 4.0, 1.0)
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
    // An author-level takedown is checked here, not left to the archive
    // loader: this is a server function, callable on its own. Record-level
    // ones are left out inside searchPosts.
    if (await anyHidden(db, [did]))
      return { ready: true, hits: [], more: false };
    const found = await searchPosts(db, did, match);
    return {
      ready: true,
      hits: found.slice(0, SEARCH_RESULT_LIMIT),
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
