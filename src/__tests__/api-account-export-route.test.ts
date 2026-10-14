// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/account/export handler behavior: session gate, cross-site refusal, and
 * that the response is the caller's OWN data, assembled with the SESSION DID
 * (never anything client-supplied) — the store's ownership enforcement
 * itself is pinned separately in rights-store.test.ts.
 */
const store = vi.hoisted(() => ({
  selectDraftsForExport: vi.fn(),
  selectFollowerSnapshotsForExport: vi.fn(),
  selectHandleHistoryForExport: vi.fn(),
  selectImportItemsForExport: vi.fn(),
  selectScheduledPostsForExport: vi.fn(),
  selectHostedPublicationForExport: vi.fn(),
  selectReaderEmailsForExport: vi.fn(),
  countReaderEmailsForDid: vi.fn(),
}));
vi.mock("~/lib/rights-store", () => ({
  ...store,
  MAX_READER_EMAILS_PER_EXPORT: 1000,
}));

const atproto = vi.hoisted(() => ({
  resolveDidIdentity: vi.fn(),
  listRecords: vi.fn(),
}));
vi.mock("~/lib/atproto", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/atproto")>("../lib/atproto");
  return { ...actual, ...atproto };
});

import { signSession } from "../lib/session";
import { Route } from "../routes/api.account.export";
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

const handlers = { POST: handlerOf(Route, "POST") };

const DID = "did:plc:fake2222222222writer2222";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers
const NOW = new Date("2026-07-27T12:00:00.000Z");

async function sessionCookie(): Promise<string> {
  return `gr_session=${await signSession(DID, "test-sid", SECRET)}`;
}

async function call(authed = true, crossSite = false): Promise<Response> {
  const request = new Request("http://127.0.0.1:3000/api/account/export", {
    headers: {
      ...(authed ? { cookie: await sessionCookie() } : {}),
      ...(crossSite ? { origin: "https://evil.example" } : {}),
    },
    method: "POST",
  });
  return handlers.POST({ request });
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  for (const fn of Object.values(atproto)) fn.mockReset();
  store.selectDraftsForExport.mockResolvedValue([]);
  store.selectHostedPublicationForExport.mockResolvedValue([]);
  store.selectImportItemsForExport.mockResolvedValue([]);
  store.selectFollowerSnapshotsForExport.mockResolvedValue([]);
  store.selectScheduledPostsForExport.mockResolvedValue([]);
  store.selectReaderEmailsForExport.mockResolvedValue([]);
  store.countReaderEmailsForDid.mockResolvedValue([{ n: 0 }]);
  store.selectHandleHistoryForExport.mockResolvedValue([]);
  atproto.resolveDidIdentity.mockResolvedValue({ handle: null, pds: null });
});

describe("session gate", () => {
  it("401s without a session, and never touches the store", async () => {
    const res = await call(false);
    expect(res.status).toBe(401);
    expect(store.selectDraftsForExport).not.toHaveBeenCalled();
  });

  it("403s a cross-site request even with a valid session", async () => {
    const res = await call(true, true);
    expect(res.status).toBe(403);
    expect(store.selectDraftsForExport).not.toHaveBeenCalled();
  });
});

describe("response shape", () => {
  it("is a no-store JSON attachment", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".json");
  });

  it("reads drafts and the import ledger with the SESSION did, never a client-supplied one", async () => {
    await call();
    expect(store.selectDraftsForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    expect(store.selectImportItemsForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
  });

  it("includes full draft content, parsed", async () => {
    store.selectDraftsForExport.mockResolvedValue([
      {
        id: "d1",
        title: "Hello",
        content: '[{"type":"paragraph"}]',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await call();
    const body = (await res.json()) as {
      drafts: { id: string; content: unknown }[];
    };
    expect(body.drafts).toEqual([
      {
        id: "d1",
        title: "Hello",
        content: [{ type: "paragraph" }],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  it("nulls a corrupt draft's content instead of failing the whole export", async () => {
    store.selectDraftsForExport.mockResolvedValue([
      {
        id: "d1",
        title: "",
        content: "{oops",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: { content: unknown }[] };
    expect(body.drafts[0].content).toBeNull();
  });

  it("includes the import ledger", async () => {
    store.selectImportItemsForExport.mockResolvedValue([
      {
        id: "i1",
        sourceUrl: "https://writer.example/post",
        originalAt: NOW,
        draftId: null,
        publishedRkey: "3lz2222222222",
        adoptedAt: null,
        createdAt: NOW,
      },
    ]);
    const res = await call();
    const body = (await res.json()) as {
      importLedger: { id: string; sourceUrl: string }[];
    };
    expect(body.importLedger).toEqual([
      {
        id: "i1",
        sourceUrl: "https://writer.example/post",
        originalAt: NOW.toISOString(),
        draftId: null,
        publishedRkey: "3lz2222222222",
        adoptedAt: null,
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it("includes the sitemap's listing of the writer's publication", async () => {
    store.selectHostedPublicationForExport.mockResolvedValue([
      {
        ident: "writer.example",
        updatedAt: new Date("2026-10-01T09:00:00.000Z"),
      },
    ]);
    const res = await call();
    expect(store.selectHostedPublicationForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    const body = (await res.json()) as { sitemapListing: unknown };
    expect(body.sitemapListing).toEqual({
      page: "http://127.0.0.1:3000/@writer.example",
      lastPublishedAt: "2026-10-01T09:00:00.000Z",
    });
  });

  it("includes the follower history we hold — it's the writer's own data, and nobody can rebuild it from upstream", async () => {
    store.selectFollowerSnapshotsForExport.mockResolvedValue([
      { day: "2026-07-28", followers: 120, posts: 8 },
      { day: "2026-07-29", followers: 124, posts: null },
    ]);
    const res = await call();
    expect(store.selectFollowerSnapshotsForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    const body = (await res.json()) as {
      followerHistory: { day: string; followers: number }[];
      manifest: string;
    };
    expect(body.followerHistory).toEqual([
      { day: "2026-07-28", followers: 120, posts: 8 },
      { day: "2026-07-29", followers: 124, posts: null },
    ]);
    // The manifest is the writer's plain-language index of what we hold, so it
    // has to name this too — it can't quietly list only the older categories.
    expect(body.manifest).toMatch(/follower/i);
  });

  it("includes the handles recorded for the account, and says so", async () => {
    store.selectHandleHistoryForExport.mockResolvedValue([
      { handle: "writer.example", seenAt: NOW },
    ]);
    const res = await call();
    expect(store.selectHandleHistoryForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    const body = (await res.json()) as {
      handleHistory: unknown;
      manifest: string;
    };
    expect(body.handleHistory).toEqual([
      { handle: "writer.example", recordedAt: NOW.toISOString() },
    ]);
    expect(body.manifest).toMatch(/handles/i);
  });

  it("includes the scheduled posts we hold, failure reasons and all", async () => {
    store.selectScheduledPostsForExport.mockResolvedValue([
      {
        draftId: "11111111-2222-4333-8444-555555555555",
        dueAt: new Date("2026-08-04T06:00:00.000Z"),
        status: "failed",
        attempts: 3,
        lastError: "Your sign-in with your data server is no longer valid.",
        publishedRkey: null,
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    ]);
    const res = await call();
    expect(store.selectScheduledPostsForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    const body = (await res.json()) as {
      scheduledPosts: Array<{ dueAt: string; lastError: string | null }>;
      manifest: string;
    };
    expect(body.scheduledPosts).toEqual([
      {
        draftId: "11111111-2222-4333-8444-555555555555",
        dueAt: "2026-08-04T06:00:00.000Z",
        status: "failed",
        attempts: 3,
        // Verbatim: our account of why their post did not go out is theirs.
        lastError: "Your sign-in with your data server is no longer valid.",
        publishedRkey: null,
        createdAt: "2026-08-01T10:00:00.000Z",
      },
    ]);
    expect(body.manifest).toMatch(/scheduled/i);
  });

  it("degrades ownPosts to null (never fails the export) when the PDS read flakes", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: null,
      pds: "https://pds.example",
    });
    atproto.listRecords.mockRejectedValue(new Error("pds unreachable"));
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ownPosts: { posts: unknown } };
    expect(body.ownPosts.posts).toBeNull();
  });

  it("lists own posts read live from the PDS when it resolves", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: null,
      pds: "https://pds.example",
    });
    atproto.listRecords.mockResolvedValue([
      {
        uri: "at://did/site.standard.document/abc",
        cid: "bafy",
        value: { title: "My post", path: "/abc", publishedAt: "2026-01-01" },
      },
    ]);
    const res = await call();
    const body = (await res.json()) as {
      ownPosts: {
        pdsRepoExportUrl: string;
        posts: { uri: string; title?: string }[];
      };
    };
    expect(body.ownPosts.posts).toEqual([
      {
        uri: "at://did/site.standard.document/abc",
        path: "/abc",
        title: "My post",
        publishedAt: "2026-01-01",
      },
    ]);
    expect(body.ownPosts.pdsRepoExportUrl).toContain(
      "com.atproto.repo.getRepo",
    );
  });

  it("names the manifest note explaining posts live in the writer's own repo", async () => {
    const res = await call();
    const body = (await res.json()) as { manifest: string };
    expect(body.manifest).toMatch(/your own atproto data repo/i);
  });

  /**
   * The export can only ever reach rows keyed by the caller's DID. A waitlist
   * signup and an abuse report are keyed by an email and carry no DID (see
   * ~/lib/rights-store's note on why no link exists), so the manifest has to
   * say so rather than let "that's everything" stand — the same disclosure
   * /privacy makes.
   */
  it("admits what it cannot reach: an email with no DID beside it", async () => {
    const res = await call();
    const { manifest } = (await res.json()) as { manifest: string };
    expect(manifest).toMatch(/waitlist/i);
    expect(manifest).toMatch(/report/i);
    expect(manifest).toMatch(/privacy@trygoldroad\.com/);
    // And it must not claim completeness in the same breath.
    expect(manifest).not.toMatch(/that's it/i);
  });

  /**
   * The writer controls their publication's reader list and Goldroad holds it
   * for them, so the export is where they get it: every address, where it was
   * left, and when.
   */
  it("hands the writer their reader list, with where and when each was left", async () => {
    store.selectReaderEmailsForExport.mockResolvedValue([
      {
        email: "first@example.com",
        source: "post",
        consentedAt: new Date("2026-09-01T10:00:00.000Z"),
      },
      {
        email: "second@example.com",
        source: "publication",
        consentedAt: new Date("2026-09-02T11:30:00.000Z"),
      },
    ]);
    store.countReaderEmailsForDid.mockResolvedValue([{ n: 2 }]);
    const res = await call();
    const body = (await res.json()) as {
      manifest: string;
      readerList: {
        count: number;
        truncated: boolean;
        note: string;
        readers: { email: string; source: string; consentedAt: string }[];
      };
    };

    expect(store.selectReaderEmailsForExport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
    );
    expect(body.readerList.count).toBe(2);
    expect(body.readerList.readers).toEqual([
      {
        email: "first@example.com",
        source: "post",
        consentedAt: "2026-09-01T10:00:00.000Z",
      },
      {
        email: "second@example.com",
        source: "publication",
        consentedAt: "2026-09-02T11:30:00.000Z",
      },
    ]);
    expect(body.readerList.truncated).toBe(false);
    expect(body.manifest).toMatch(/yours to control/i);
    expect(body.manifest).toMatch(/on your behalf/i);
    // Nothing confirms an address, and the writer has to know that.
    expect(body.manifest).toMatch(/nobody confirms these addresses/i);
    expect(body.readerList.note).toMatch(/^Unconfirmed/);
  });

  it("says when a padded list was cut, and gives the true total", async () => {
    store.selectReaderEmailsForExport.mockResolvedValue([
      { email: "a@example.com", source: "post", consentedAt: new Date(0) },
    ]);
    store.countReaderEmailsForDid.mockResolvedValue([{ n: 5000 }]);
    const body = (await (await call()).json()) as {
      readerList: { count: number; truncated: boolean };
    };
    expect(body.readerList).toMatchObject({ count: 5000, truncated: true });
  });

  it("exports a row with an unreadable date rather than failing", async () => {
    store.selectReaderEmailsForExport.mockResolvedValue([
      { email: "a@example.com", source: "post", consentedAt: new Date(NaN) },
    ]);
    store.countReaderEmailsForDid.mockResolvedValue([{ n: 1 }]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readerList: { readers: { consentedAt: string | null }[] };
    };
    expect(body.readerList.readers[0].consentedAt).toBeNull();
  });

  it("no longer claims the file is everything keyed to the DID", async () => {
    const res = await call();
    const { manifest } = (await res.json()) as { manifest: string };
    expect(manifest).not.toMatch(/that is everything we hold keyed to your/i);
    // It names the reader list instead, and what happens to it on deletion.
    expect(manifest).toMatch(/readerList/);
    expect(manifest).toMatch(/deleted along with everything else/i);
  });
});
