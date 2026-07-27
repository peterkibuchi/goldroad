/**
 * atproto OAuth client factory.
 *
 * - Production (https): confidential client bound to CANONICAL_ORIGIN —
 *   NOT the request origin. client_id is origin-bound and effectively
 *   permanent: every production hostname (trygoldroad.com,
 *   workers.dev, previews) must present the identical client identity, or
 *   sessions fracture across hostnames. client_id is the metadata URL;
 *   private_key_jwt assertions signed with OAUTH_PRIVATE_KEY_JWK (Workers secret).
 * - Dev (localhost / 127.0.0.1): loopback PUBLIC client — the library builds the
 *   special loopback client_id itself when no client_id is given. Loopback
 *   redirect URIs must use 127.0.0.1 (RFC 8252), so browse the dev app at
 *   http://127.0.0.1:3000 or the session cookie lands on the wrong host.
 *
 * Sessions + authorize states live in D1 (table `oauth_kv`), NOT Workers KV:
 * KV's eventual consistency can lose the ~10s authorize→callback roundtrip.
 * @atcute/oauth-node-client is verified working on workerd
 * (slop/atcute-worker-smoke); @atproto/oauth-client-node is broken there
 * (bluesky-social/atproto#3292).
 */
import {
  CompositeDidDocumentResolver,
  CompositeHandleResolver,
  DohJsonHandleResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import {
  type ClientAssertionPrivateJwk,
  OAuthClient,
  type OAuthClientStores,
  type Store,
  type StoredState,
} from "@atcute/oauth-node-client";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { oauthKv } from "~/db/schema";
import { SCOPES } from "~/lib/oauth-scopes";
import { canonicalOrigin, isLoopbackOrigin } from "~/lib/origin";
import { env } from "cloudflare:workers";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** get/set/delete/clear over `oauth_kv`; values are plain JSON. */
class D1Store<V> implements Store<string, V> {
  constructor(
    private readonly db: DrizzleD1,
    private readonly prefix: string,
    /** unix-ms expiry extracted from the value (states); undefined = no expiry. */
    private readonly expiry?: (value: V) => number | undefined,
  ) {}

  async get(key: string): Promise<V | undefined> {
    const row = await this.db
      .select()
      .from(oauthKv)
      .where(eq(oauthKv.k, this.prefix + key))
      .get();
    if (!row) return undefined;
    if (row.expiresAt != null && row.expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return JSON.parse(row.v) as V;
  }

  async set(key: string, value: V): Promise<void> {
    const record = {
      k: this.prefix + key,
      v: JSON.stringify(value),
      expiresAt: this.expiry?.(value) ?? null,
    };
    await this.db
      .insert(oauthKv)
      .values(record)
      .onConflictDoUpdate({
        target: oauthKv.k,
        set: { v: record.v, expiresAt: record.expiresAt },
      });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(oauthKv).where(eq(oauthKv.k, this.prefix + key));
  }

  async clear(): Promise<void> {
    await this.db.delete(oauthKv).where(like(oauthKv.k, `${this.prefix}%`));
  }
}

// Stateless resolver config; safe to share across requests within an isolate.
const actorResolver = new LocalActorResolver({
  handleResolver: new CompositeHandleResolver({
    methods: {
      dns: new DohJsonHandleResolver({
        dohUrl: "https://cloudflare-dns.com/dns-query",
      }),
      http: new WellKnownHandleResolver(),
    },
  }),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  }),
});

/**
 * Builds the OAuth client for the given request origin (e.g.
 * `new URL(request.url).origin`). Non-loopback origins are canonicalized to
 * CANONICAL_ORIGIN so the client identity is hostname-independent.
 *
 * KNOWN LIMITATION: a sign-in started from a versioned preview hostname
 * (*-goldroad.kibuchi.workers.dev) redirects back to the CANONICAL redirect
 * URI — the flow completes on production, not on the preview. Accepted:
 * interactive OAuth is testable in local dev (loopback client) and in
 * production; per-preview OAuth identities were rejected (each preview would
 * demand its own PDS consent and fracture sessions, for no benefit at our
 * team size). Preview URLs exist to review UI, not auth flows.
 */
export function createOAuthClient(requestOrigin: string): OAuthClient {
  const origin = canonicalOrigin(requestOrigin);
  const db = drizzle(env.DB);
  const stores: OAuthClientStores = {
    sessions: new D1Store(db, "sess:"),
    states: new D1Store<StoredState>(db, "state:", (s) => s.expiresAt),
    // dpopNonces/asMetadata/prMetadata: in-memory defaults are fine (best-effort caches).
  };

  if (isLoopbackOrigin(origin)) {
    const port = new URL(origin).port || "3000";
    return new OAuthClient({
      // No client_id + no keyset → the library builds the loopback public client.
      metadata: {
        redirect_uris: [`http://127.0.0.1:${port}/oauth/callback`],
        scope: SCOPES,
      },
      stores,
      actorResolver,
    });
  }

  if (!env.OAUTH_PRIVATE_KEY_JWK) {
    throw new Error(
      "OAUTH_PRIVATE_KEY_JWK secret is not set (required for the confidential client on non-loopback origins)",
    );
  }
  return new OAuthClient({
    metadata: {
      client_id: `${origin}/oauth/client-metadata.json`,
      redirect_uris: [`${origin}/oauth/callback`],
      scope: SCOPES,
      jwks_uri: `${origin}/oauth/jwks.json`,
      client_name: "Goldroad",
      client_uri: origin,
    },
    keyset: [
      JSON.parse(env.OAUTH_PRIVATE_KEY_JWK) as ClientAssertionPrivateJwk,
    ],
    stores,
    actorResolver,
  });
}

/** Guard against open redirects: only allow same-site absolute paths. */
export function safeReturnTo(value: unknown, fallback = "/write"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
