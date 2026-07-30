/**
 * A signed cookie is not the same thing as a live session.
 *
 * The cookie is a self-contained bearer token with a 30-day ceiling, so
 * verifying it proves only that we issued it and that it isn't ancient. Signing
 * out drops the server-side session row; before this gate existed, a copy of
 * the cookie taken beforehand kept working against every endpoint that reads
 * the writer's own data — including account export and account deletion, which
 * are exactly what someone reaches for when they think a device was exposed.
 */
import { describe, expect, it } from "vitest";

import { hasLiveSession, readLiveSessionDid } from "../lib/live-session";
import { signSession } from "../lib/session";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const SECRET = "vitest-fake-cookie-secret";

/** drizzle's `eq()` builds an opaque SQL node, so rather than assume its shape
 * we walk it for the bound key — the one string that looks like a session key. */
function boundSessionKey(
  node: unknown,
  seen = new Set<unknown>(),
): string | undefined {
  if (typeof node === "string")
    return node.startsWith("sess:") ? node : undefined;
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = boundSessionKey(value, seen);
    if (found) return found;
  }
  return undefined;
}

/** A stand-in for the one indexed read `hasLiveSession` performs: `.get()`
 * resolves to the row when the key is present, `undefined` when it isn't. */
function dbWithKeys(keys: string[]) {
  let requested: string | undefined;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (cond: unknown) => {
      requested = boundSessionKey(cond);
      return chain;
    },
    get: async () =>
      requested && keys.includes(requested) ? { k: requested } : undefined,
  };
  return chain as unknown as Parameters<typeof hasLiveSession>[0];
}

async function cookieRequest(did = DID): Promise<Request> {
  return new Request("https://example.test/api/drafts", {
    headers: { cookie: `gr_session=${await signSession(did, SECRET)}` },
  });
}

describe("readLiveSessionDid", () => {
  it("accepts a valid cookie whose session row is still there", async () => {
    const did = await readLiveSessionDid(
      await cookieRequest(),
      SECRET,
      dbWithKeys([`sess:${DID}`]),
    );
    expect(did).toBe(DID);
  });

  it("refuses a still-valid cookie once the session has been signed out", async () => {
    // Same cookie, same signature, still inside its 30 days — the only thing
    // that changed is that the session row is gone. That must be enough.
    const did = await readLiveSessionDid(
      await cookieRequest(),
      SECRET,
      dbWithKeys([]),
    );
    expect(did).toBeNull();
  });

  it("refuses a request with no cookie without touching the database", async () => {
    let touched = false;
    const db = {
      select: () => {
        touched = true;
        return db;
      },
      from: () => db,
      where: () => db,
      get: async () => undefined,
    } as unknown as Parameters<typeof hasLiveSession>[0];

    const did = await readLiveSessionDid(
      new Request("https://example.test/api/drafts"),
      SECRET,
      db,
    );
    expect(did).toBeNull();
    expect(touched).toBe(false);
  });

  it("refuses a cookie signed with a different secret", async () => {
    const request = new Request("https://example.test/api/drafts", {
      headers: { cookie: `gr_session=${await signSession(DID, "other")}` },
    });
    expect(
      await readLiveSessionDid(request, SECRET, dbWithKeys([`sess:${DID}`])),
    ).toBeNull();
  });

  it("looks the session up under its own DID, never another writer's", async () => {
    // A live session for someone else must not authenticate this cookie.
    const other = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
    expect(
      await readLiveSessionDid(
        await cookieRequest(),
        SECRET,
        dbWithKeys([`sess:${other}`]),
      ),
    ).toBeNull();
  });
});

describe("hasLiveSession", () => {
  it("is true only when the exact session key exists", async () => {
    expect(await hasLiveSession(dbWithKeys([`sess:${DID}`]), DID)).toBe(true);
    expect(await hasLiveSession(dbWithKeys([]), DID)).toBe(false);
  });
});
