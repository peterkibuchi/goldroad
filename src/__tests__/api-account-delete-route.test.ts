// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/account/delete handler behavior: session gate, cross-site refusal,
 * that EVERY store delete is called with the SESSION did (never anything
 * client-supplied — ownership itself is pinned in rights-store.test.ts), that
 * a failed upstream token revoke never blocks the deletion, and that the
 * session cookie is always cleared on success.
 */
const store = vi.hoisted(() => ({
  deleteDraftsForDid: vi.fn(),
  deleteFollowerSnapshotsForDid: vi.fn(),
  deleteImportItemsForDid: vi.fn(),
  deleteImportFetchesForDid: vi.fn(),
  deleteOAuthSessionForDid: vi.fn(),
  deleteReaderEmailsForDid: vi.fn(),
  deleteScheduledPostsForDid: vi.fn(),
}));
vi.mock("~/lib/rights-store", () => store);

const revoke = vi.hoisted(() => vi.fn());
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: vi.fn(() => ({ revoke })),
}));

import { signSession } from "../lib/session";
import { Route } from "../routes/api.account.delete";
import { handlerOf } from "./support/route-handler";

// The liveness half of the session gate needs a real database, which these
// route suites deliberately don't have — they stub the stores. So the D1 read
// is mocked to "the session is live" and the cookie half runs for real, which
// is what these suites are about. Revocation itself is covered end-to-end in
// live-session.test.ts.
vi.mock("~/lib/live-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-session")>();
  const { readSessionDid } = await import("../lib/session");
  return {
    ...actual,
    readLiveSessionDid: (request: Request, secret: string) =>
      readSessionDid(request, secret),
  };
});

const handler = handlerOf(Route, "POST");

const DID = "did:plc:fake2222222222writer2222";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers

async function sessionCookie(): Promise<string> {
  return `gr_session=${await signSession(DID, SECRET)}`;
}

async function call(authed = true, crossSite = false): Promise<Response> {
  const request = new Request("http://127.0.0.1:3000/api/account/delete", {
    headers: {
      ...(authed ? { cookie: await sessionCookie() } : {}),
      ...(crossSite ? { origin: "https://evil.example" } : {}),
    },
    method: "POST",
  });
  return handler({ request });
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  revoke.mockReset();
  for (const fn of Object.values(store)) fn.mockResolvedValue([]);
  revoke.mockResolvedValue(undefined);
});

describe("guards", () => {
  it("redirects to /settings with an error, and never touches the store, when signed out", async () => {
    const res = await call(false);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/settings?error=delete_account_failed",
    );
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it("redirects to /settings with an error on a cross-site request, even with a valid session", async () => {
    const res = await call(true, true);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/settings?error=delete_account_failed",
    );
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("deletion", () => {
  it("deletes drafts, import ledger, import-fetch rows, follower history and scheduled posts for the SESSION did", async () => {
    await call();
    expect(store.deleteDraftsForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    // Every table keyed by a writer's DID is swept here. A row category that
    // ships without its delete is one nobody can ever reach again.
    expect(store.deleteFollowerSnapshotsForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    expect(store.deleteImportItemsForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    expect(store.deleteImportFetchesForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    // A pending scheduled post is queued WORK, not just a record: leaving one
    // behind would have the cron publishing for a deleted account.
    expect(store.deleteScheduledPostsForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
  });

  it("deletes the addresses readers left with the writer's publication", async () => {
    // The table is keyed by `writer_did` and was missed by this sweep for as
    // long as it existed: a deleted account went on holding a list of other
    // people's email addresses, with nothing left that could justify keeping
    // them and no one able to reach them.
    await call();
    expect(store.deleteReaderEmailsForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
  });

  it("revokes the upstream OAuth session and deletes the D1 session row directly", async () => {
    await call();
    expect(revoke).toHaveBeenCalledWith(DID);
    expect(store.deleteOAuthSessionForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
  });

  it("a failed upstream revoke never blocks the deletion (best-effort)", async () => {
    revoke.mockRejectedValue(new Error("upstream down"));
    const res = await call();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?notice=goodbye");
    expect(store.deleteOAuthSessionForDid).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
  });

  it("succeeds, clears the session cookie, and sends a calm goodbye redirect", async () => {
    const res = await call();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?notice=goodbye");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("gr_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("is idempotent — a second call with zero matching rows still succeeds", async () => {
    for (const fn of Object.values(store)) fn.mockResolvedValue([]);
    const first = await call();
    const second = await call();
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("/?notice=goodbye");
  });
});
