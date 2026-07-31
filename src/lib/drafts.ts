/**
 * Draft store — the D1 queries behind /api/drafts. Drafts are private,
 * per-writer rows; OWNERSHIP IS ENFORCED HERE, in the SQL itself: every
 * single-row query pairs the draft id with the owner DID in its WHERE, so a
 * caller can never reach another writer's draft no matter what the handler
 * does. Mutations use RETURNING so "no row matched" (missing OR not yours —
 * deliberately the same answer) is visible to the caller as an empty result.
 *
 * Functions return drizzle query builders (awaitable), not results — the
 * shape of each query is unit-testable via .toSQL() without a live D1
 * (same pattern as ~/lib/scheduled).
 */
import { and, count, desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { drafts } from "~/db/schema";
import { MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** A writer's drafts, newest first — list metadata only, no content (the
 * dashboard list never needs block JSON). Capped at the per-writer maximum;
 * id is the tiebreaker so equal timestamps keep a stable order. */
export function listDrafts(db: DrizzleD1, did: string) {
  return db
    .select({
      id: drafts.id,
      title: drafts.title,
      createdAt: drafts.createdAt,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.did, did))
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(MAX_DRAFTS_PER_USER);
}

/** One draft, content included — only when `did` owns it. */
export function selectDraft(db: DrizzleD1, did: string, id: string) {
  return db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.did, did)))
    .limit(1);
}

/** How many drafts a writer has (the create-cap check). */
export function countDrafts(db: DrizzleD1, did: string) {
  return db.select({ n: count() }).from(drafts).where(eq(drafts.did, did));
}

/** Creates a draft. `id` is minted by the caller (crypto.randomUUID());
 * created_at/updated_at come from the schema defaults. `markdown` (the publish
 * projection) defaults to "" in the schema, so a caller with nothing to project
 * yet may omit it. */
export function insertDraft(
  db: DrizzleD1,
  row: {
    id: string;
    did: string;
    title: string;
    dek: string;
    content: string;
    markdown?: string;
    inlineImages?: string;
  },
) {
  return db
    .insert(drafts)
    .values(row)
    .returning({ id: drafts.id, updatedAt: drafts.updatedAt });
}

/**
 * Updates a draft the writer owns; empty result = missing or not theirs.
 * Every writable field is passed on every save (the editor always knows all of
 * them), so a cleared subtitle clears the column.
 *
 * `markdown` and `inlineImages` are the exceptions, and deliberately so:
 * UNDEFINED LEAVES THE STORED VALUE ALONE. Between them they are the only copy
 * of a document a cron can publish (~/db/schema), so a caller that simply
 * didn't send one must not be able to blank it — writing "" over the markdown
 * would turn a scheduled post into an empty one, and over the image references
 * would publish a post whose own pictures are broken. An explicit "" still
 * clears either, which is what an emptied editor sends.
 */
export function updateDraft(
  db: DrizzleD1,
  did: string,
  id: string,
  fields: {
    title: string;
    dek: string;
    content: string;
    markdown?: string;
    inlineImages?: string;
  },
) {
  const { markdown, inlineImages, ...always } = fields;
  return db
    .update(drafts)
    .set({
      ...always,
      ...(markdown === undefined ? {} : { markdown }),
      ...(inlineImages === undefined ? {} : { inlineImages }),
      updatedAt: new Date(),
    })
    .where(and(eq(drafts.id, id), eq(drafts.did, did)))
    .returning({ id: drafts.id, updatedAt: drafts.updatedAt });
}

/** Deletes a draft the writer owns; empty result = missing or not theirs. */
export function deleteDraft(db: DrizzleD1, did: string, id: string) {
  return db
    .delete(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.did, did)))
    .returning({ id: drafts.id });
}
