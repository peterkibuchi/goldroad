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
 * Takedown list (moderation kit, audit #1). trygoldroad.com renders and proxies
 * arbitrary third-party atproto content, so it needs a lever to stop serving a
 * given subject. `subject` is either a DID ("did:plc:…" — hides an entire
 * author, including their /img blobs) or an AT-URI
 * ("at://did/collection/rkey" — hides one record). The reader loaders and the
 * /img proxy consult this before serving. No admin UI yet: rows are inserted by
 * hand via `wrangler d1 execute` (SQL documented on /policies + in the PR).
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
 * Abuse reports from the public "Report" link (moderation kit, audit #1).
 * `url` is the reported page, `reason` the reporter's note, `email` optional
 * for follow-up. Same anti-abuse posture as the waitlist: honeypot + validation
 * (a Turnstile token verification point is left for the owner). A human triages
 * these against the hidden_content list.
 */
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
 */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
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

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  reason: text("reason").notNull(),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
