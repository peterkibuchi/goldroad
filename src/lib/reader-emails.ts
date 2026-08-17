/**
 * The `reader_emails` write, in one place.
 *
 * A drizzle query builder rather than an executed statement, so the property
 * that matters here — that a second submission of the same address is a no-op
 * rather than an error or a second row — is verifiable with `.toSQL()` and no
 * live D1 (the shape ~/lib/reports and ~/lib/backup already use).
 *
 * IDEMPOTENCE IS THE SECURITY PROPERTY, not a convenience. If a duplicate
 * failed, the endpoint would answer differently for an address it already holds
 * than for one it doesn't, and anyone could ask it whether a given reader
 * follows a given writer. `onConflictDoNothing` makes both cases the same 200,
 * and keeps the FIRST consent timestamp rather than overwriting it.
 */
import type { drizzle } from "drizzle-orm/d1";

import { readerEmails } from "~/db/schema";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** What the endpoint has after validation: the address, whose list it joins,
 * and which surface it came from. */
export type ReaderEmailEntry = {
  email: string;
  writerDid: string;
  source: "post" | "publication";
};

export function insertReaderEmail(db: DrizzleD1, entry: ReaderEmailEntry) {
  return db.insert(readerEmails).values(entry).onConflictDoNothing();
}
