import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  reason: text("reason").notNull(),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
