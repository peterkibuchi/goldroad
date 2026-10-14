// @vitest-environment node
/**
 * A signed cookie is not the same thing as a live session.
 *
 * Verifying the cookie proves only that we issued it and that it isn't
 * ancient. Signing out drops the server-side session row; before this gate
 * existed, a copy of the cookie taken beforehand kept working against every
 * endpoint that reads the writer's own data — including account export and
 * account deletion, which are exactly what someone reaches for when they think
 * a device was exposed. The sign-out/sign-in and expiry cases are in
 * session-lifecycle.test.ts.
 */
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";

import { oauthKv } from "../db/schema";
import { readLiveSessionDid } from "../lib/live-session";
import { signSession } from "../lib/session";
import { sqliteD1 } from "./support/sqlite-d1";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const SID = "the-rows-sid";
const SECRET = "vitest-fake-cookie-secret";

async function dbWithSession(did = DID) {
  const d1 = sqliteD1();
  const db = drizzle(d1);
  await db.insert(oauthKv).values({
    k: `sess:${did}`,
    v: "{}",
    sid: SID,
    expiresAt: Date.now() + 60_000,
  });
  return { d1, db };
}

async function cookieRequest(did = DID, secret = SECRET): Promise<Request> {
  return new Request("https://example.test/api/drafts", {
    headers: { cookie: `gr_session=${await signSession(did, SID, secret)}` },
  });
}

describe("readLiveSessionDid", () => {
  it("accepts a valid cookie whose session row is still there", async () => {
    const { db } = await dbWithSession();
    expect(await readLiveSessionDid(await cookieRequest(), SECRET, db)).toBe(
      DID,
    );
  });

  it("refuses a still-valid cookie once the session has been signed out", async () => {
    const { db } = await dbWithSession();
    await db.delete(oauthKv);
    expect(
      await readLiveSessionDid(await cookieRequest(), SECRET, db),
    ).toBeNull();
  });

  it("refuses a request with no cookie without touching the database", async () => {
    const { d1, db } = await dbWithSession();
    const prepare = vi.spyOn(d1, "prepare");
    expect(
      await readLiveSessionDid(
        new Request("https://example.test/api/drafts"),
        SECRET,
        db,
      ),
    ).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses a cookie signed with a different secret", async () => {
    const { db } = await dbWithSession();
    expect(
      await readLiveSessionDid(await cookieRequest(DID, "other"), SECRET, db),
    ).toBeNull();
  });

  it("looks the session up under its own DID, never another writer's", async () => {
    // A live session for someone else, with the same sid, must not
    // authenticate this cookie.
    const { db } = await dbWithSession("did:plc:zzzzzzzzzzzzzzzzzzzzzzzz");
    expect(
      await readLiveSessionDid(await cookieRequest(), SECRET, db),
    ).toBeNull();
  });
});
