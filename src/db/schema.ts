import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Key-value backing for atproto OAuth sessions + authorize states.
 * D1, not Workers KV: KV's eventual consistency can lose the authorize→callback
 * roundtrip (~10s) across colos. Keys are prefixed ("sess:", "state:");
 * values are plain JSON (StoredSession / StoredState from @atcute/oauth-node-client).
 * `expiresAt` is a unix-ms timestamp; null means no expiry (sessions).
 */
export const oauthKv = sqliteTable("oauth_kv", {
  k: text("k").primaryKey(),
  v: text("v").notNull(),
  expiresAt: integer("expires_at"),
});

export const waitlist = sqliteTable("waitlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Takedown list. trygoldroad.com renders and proxies
 * arbitrary third-party atproto content, so it needs a lever to stop serving a
 * given subject. `subject` is either a DID ("did:plc:…" — hides an entire
 * author, including their /img blobs) or an AT-URI
 * ("at://did/collection/rkey" — hides one record). The reader loaders and the
 * /img proxy consult this before serving. No admin UI yet: rows are inserted by
 * hand via `wrangler d1 execute` (the SQL is documented on /policies).
 */
export const hiddenContent = sqliteTable("hidden_content", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  subject: text("subject").notNull().unique(),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Writer drafts. Drafts are PRIVATE, so they stay server-side in our D1,
 * keyed to the writer's DID — never in the writer's atproto repo, where any
 * record is public the moment it exists. Only publishing (via /api/publish)
 * writes to the writer's repo.
 *
 * `content` is the BlockNote document JSON (serialized blocks) — lossless,
 * unlike the markdown projection used at publish time, so resuming a draft
 * restores exactly what was written. `id` is an app-generated UUID; every
 * query pairs it with `did` so a draft is only ever reachable by its owner.
 * Timestamps are millisecond-precision so "newest first" stays stable across
 * rapid autosaves.
 *
 * The subtitle lives in its own column rather than inside `content`: block
 * JSON is the editor's private format, and nothing outside the editor may
 * reach into it. Empty string is the honest default — a draft with no
 * subtitle, not a missing one.
 *
 * `inline_images` is the companion the projection needs: the JSON blob
 * references for body images already uploaded to the writer's repo
 * (~/lib/inline-images). A PDS only serves a blob some record references, so a
 * post published without them renders its own images as broken — and the
 * browser's per-session store of those references is gone by the time a cron
 * runs. "" means "no body images", and a save from a session that uploaded none
 * leaves whatever is stored alone (the same rule `markdown` follows).
 *
 * `markdown` is the SAME projection publishing sends to the record's
 * `textContent`, saved next to the blocks it came from. It exists because that
 * projection can only be produced by the editor: `blocksToMarkdownLossy` needs
 * a live BlockNote instance (ProseMirror, a real DOM), which a Workers cron
 * does not have and never will. Storing it makes the draft — not a copy of it
 * — the thing scheduled publishing publishes. Written on every save, so it can
 * never drift from `content`; "" for drafts last saved before the column
 * existed, which is why scheduling writes it before it schedules anything.
 */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull(),
    title: text("title").notNull().default(""),
    dek: text("dek").notNull().default(""),
    content: text("content").notNull(),
    markdown: text("markdown").notNull().default(""),
    inlineImages: text("inline_images").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Covers both the per-writer list (ORDER BY updated_at DESC) and the
  // create-time count without scanning other writers' rows.
  (table) => [index("drafts_did_updated_idx").on(table.did, table.updatedAt)],
);

/**
 * Import ledger — one row per feed item a writer has imported (RSS import →
 * drafts). It carries three responsibilities:
 *
 *  1. Idempotency: re-running an import skips items already brought across —
 *     the (did, guid_hash) unique key is the dedupe check.
 *  2. Provenance: `source_url` + `original_at` let publishing backdate the
 *     record to the original date and let the reader page say "Originally
 *     published at …".
 *  3. Mirror flag: a row with `published_rkey` set and `adopted_at` null marks
 *     the published record as a mirror — the reader swaps its canonical tag
 *     for noindex (current search-engine syndication etiquette: noindex the
 *     republished copy rather than cross-domain canonical) and shows the
 *     provenance line. "Adopting" the post (making Goldroad the original)
 *     sets `adopted_at` — the row stays for idempotency, the mirror
 *     treatment stops.
 *
 * `guid_hash` is SHA-256 hex of the item's guid (falling back to its link):
 * fixed-width, safe to index, and never trusts arbitrary-length feed guids.
 * Rows are keyed to the writer's DID; every query pairs id fields with `did`
 * so one writer can never reach another's ledger (same policy as drafts).
 */
export const importItems = sqliteTable(
  "import_items",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull(),
    guidHash: text("guid_hash").notNull(),
    /** The item's original public URL (https, validated) — provenance. */
    sourceUrl: text("source_url"),
    /** The item's original publication date, for backdated publishing. */
    originalAt: integer("original_at", { mode: "timestamp_ms" }),
    /** The draft this item landed in (draft rows may be deleted later). */
    draftId: text("draft_id"),
    /** Set when the draft is published — the record's rkey in the writer's repo. */
    publishedRkey: text("published_rkey"),
    /** Set when the writer adopts the post as the Goldroad original. */
    adoptedAt: integer("adopted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // The idempotency key: one ledger row per (writer, feed item).
    uniqueIndex("import_items_did_guid_idx").on(table.did, table.guidHash),
    // Publish-time lookup (by the draftId the publish form already carries).
    index("import_items_did_draft_idx").on(table.did, table.draftId),
    // Reader-page mirror lookup (by the published record's rkey).
    index("import_items_did_rkey_idx").on(table.did, table.publishedRkey),
  ],
);

/**
 * Scheduled publishing — one row per draft a writer has told us to publish at
 * a given moment. The hourly cron (~/lib/scheduled-posts) does the publishing.
 *
 * IT REFERENCES A DRAFT, IT DOES NOT COPY ONE. `draft_id` + `did` is the whole
 * payload: title, subtitle and the markdown projection are read from the draft
 * row at publish time, so editing a scheduled draft changes what goes out —
 * which is what a writer means by "this piece publishes on Tuesday". A
 * snapshot taken at schedule time would quietly publish the older words.
 *
 * `due_at` is UTC (unix ms), always. The writer's local time is a rendering
 * concern — a zone offset resolved in the browser at submit time, converted
 * once at the write door (~/lib/schedule-time) and never stored. A stored
 * offset is a stored guess about a future DST rule.
 *
 * `status` is 'pending' | 'published' | 'failed'. Cancelling DELETES the row
 * (nothing due, nothing shown, nothing to garbage-collect), so there is no
 * fourth state. A 'published' row is kept as the double-publish guard — the
 * claim below plus a terminal status is what makes a retried or overlapping
 * tick unable to publish the same draft twice — and pruned once it is old
 * enough to be past the reach of any retry.
 *
 * `attempts` and `last_error` are the honesty columns. A cron firing hours
 * after the writer walked away can fail for reasons they must be able to read
 * (a revoked OAuth grant, a PDS that answered 400), so every failure is
 * written down in words the posts manager shows them. A scheduled post that
 * silently never went out is the worst outcome this feature has, and these two
 * columns are what make it impossible.
 *
 * `claimed_at` is the cron's lease on a row: it is set by a conditional UPDATE
 * that only one tick can win (see `claimDuePost`), and cleared when the row
 * reaches a terminal state or is released for retry. A lease older than
 * STALE_CLAIM_MS means the tick holding it died mid-flight, and the row is
 * released rather than stranded — a stranded row is the silent failure again.
 */
export const scheduledPosts = sqliteTable(
  "scheduled_posts",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull(),
    draftId: text("draft_id").notNull(),
    dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", {
      enum: ["pending", "published", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** A sentence the WRITER reads, not a stack trace (see `failureReason`). */
    lastError: text("last_error"),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    /** The rkey the post published under — set with status = 'published'. */
    publishedRkey: text("published_rkey"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // The due lookup, and the ONE query here that is not per-writer: the cron
    // publishes for everybody, so it leads on (status, due_at). Covering both
    // columns keeps a tick from scanning rows that are published or not yet
    // due — the table's steady state is mostly published rows awaiting prune.
    index("scheduled_posts_due_idx").on(table.status, table.dueAt),
    // Every writer-facing read (the manager's Scheduled tab, the editor's
    // "already scheduled" lookup, the export) pairs did with status.
    index("scheduled_posts_did_status_idx").on(
      table.did,
      table.status,
      table.dueAt,
    ),
    // At most one live schedule per draft: re-scheduling updates that row
    // instead of stacking a second publish behind the first. Partial, so a
    // finished row never blocks the writer scheduling that draft again.
    uniqueIndex("scheduled_posts_did_draft_pending_idx")
      .on(table.did, table.draftId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/**
 * Import rate-limit ledger: one row per /api/import feed-fetch run. The
 * endpoint is session-gated, so the abuser is an authenticated writer — a
 * cheap per-DID count over the last hour bounds how much SSRF-guarded
 * fetching one account can spend. Rows older than the window are pruned
 * inline on each check (no cron needed; the table stays tiny by
 * construction).
 */
export const importFetches = sqliteTable(
  "import_fetches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    did: text("did").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("import_fetches_did_created_idx").on(table.did, table.createdAt),
  ],
);

/**
 * Daily follower-count samples, one row per writer per UTC day.
 *
 * Bluesky's AppView answers "how many followers does this account have RIGHT
 * NOW" (app.bsky.actor.getProfile → followersCount) and nothing else: there is
 * no history endpoint, so a follower chart cannot be reconstructed after the
 * fact. History that wasn't sampled is simply gone. That's why this table is
 * filled by the hourly cron from the day it ships, ahead of anything that
 * renders it.
 *
 * `day` is a UTC calendar day as 'YYYY-MM-DD' text rather than a timestamp,
 * because a day is both what a chart plots and the idempotency key: paired
 * with `did` in a unique index, it makes the sampling pass safely re-runnable
 * — an hourly pass with `onConflictDoNothing` self-heals a missed 00:00 run
 * without ever producing two rows for one day.
 *
 * These rows are the writer's own history: they go out with the account data
 * export and are deleted with the account (see ~/lib/rights-store).
 */
export const followerSnapshots = sqliteTable(
  "follower_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    did: text("did").notNull(),
    day: text("day").notNull(),
    followers: integer("followers").notNull(),
    /** Free in the same getProfile response, so it's recorded while we're
     * there; null when the response didn't carry a usable number. */
    posts: integer("posts"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Idempotency AND the exact index every read wants
  // (did = ? AND day BETWEEN ? AND ? ORDER BY day).
  (table) => [
    uniqueIndex("follower_snapshots_did_day_idx").on(table.did, table.day),
  ],
);

/**
 * One row per completed off-platform backup — the heartbeat the hourly cron
 * watches (see ~/lib/backup).
 *
 * D1's Time Travel covers restoring THIS database; it cannot get bytes off the
 * platform, and it dies with the database it lives in. The export that closes
 * that gap runs in CI, not here, because D1's export is an account-level REST
 * operation rather than something the `DB` binding can do. That split leaves
 * one thing unaccounted for: a backup job that quietly stops running looks
 * exactly like a backup job that is working. So the CI job stamps a row here
 * only after a verified, encrypted, uploaded export, and the cron alerts when
 * the newest row goes stale.
 *
 * `bytes` is the size of the PLAINTEXT dump, not the encrypted artifact: it is
 * recorded so the freshness check can also catch the export that "succeeded"
 * and produced a near-empty file. `at` is when the export completed.
 */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    bytes: integer("bytes").notNull(),
  },
  // The only read is "newest first, limit 1".
  (table) => [index("backup_runs_at_idx").on(table.at)],
);

/**
 * Abuse reports from the public "Report" link.
 * `url` is the reported page, `reason` the reporter's note, `email` optional
 * for follow-up. Same anti-abuse posture as the waitlist: honeypot +
 * validation, with an optional Turnstile verification point. A human triages
 * these against the hidden_content list.
 *
 * `notified_at` is the alert watermark (~/lib/reports): stamped only once the
 * hourly cron's alert POST has actually succeeded, so a dropped webhook leaves
 * the row unnotified and the next tick retries it. A column rather than a
 * `created_at > now - 1h` window because a window double-alerts on an early
 * tick and silently drops reports on a missed one. Rows that predate the column
 * stay NULL and alert once on the first tick after deploy — a duplicate ping
 * about a report already triaged is cheap; a takedown nobody was told about is
 * the thing this exists to prevent.
 */
export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    reason: text("reason").notNull(),
    email: text("email"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    notifiedAt: integer("notified_at", { mode: "timestamp" }),
  },
  // PARTIAL, on the alert pass's exact query: "oldest not yet notified".
  // This table is the only one an anonymous endpoint can grow without bound,
  // it has no purge job, and it never shrinks once rows are stamped — so an
  // unindexed hourly `WHERE notified_at IS NULL ORDER BY created_at` scans and
  // sorts the whole thing every tick, and the read quota it costs grows with
  // total reports ever filed. The partial predicate keeps the index the size
  // of the OUTSTANDING queue instead, which is the number that stays small.
  (table) => [
    index("reports_unnotified_idx")
      .on(table.createdAt)
      .where(sql`${table.notifiedAt} is null`),
  ],
);
