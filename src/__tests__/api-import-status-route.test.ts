// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/import/status handler behavior: the export-upload path's pre-picker
 * check. Session + cross-site gates, payload validation (hex hashes only),
 * the shared already-imported rule (REAL ~/lib/import-flags logic over mocked
 * D1 stores — same seam as the /api/import tests), draft headroom, and the
 * D1-bound-parameter chunking that lets an archive-sized hash list through.
 */
const store = vi.hoisted(() => ({
  selectImportItems: vi.fn(),
  selectLiveDraftIds: vi.fn(),
}));
vi.mock("~/lib/import-store", () => store);

const draftsStore = vi.hoisted(() => ({
  countDrafts: vi.fn(),
}));
vi.mock("~/lib/drafts", () => draftsStore);

// `batch()` resolves its statements in order, like the real one does with a
// list of selects, so the store mocks' rows come back through the batch
// response and the REAL ~/lib/import-flags logic runs over them. Counting
// calls on it is how the round-trip budget below is measured.
const fakeDb = vi.hoisted(() => ({
  batch: vi.fn(async (queries: unknown[]) => Promise.all(queries)),
}));
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => fakeDb }));

import { LEDGER_QUERY_CHUNK } from "../lib/import-flags";
import { signSession } from "../lib/session";
import { Route } from "../routes/api.import.status";
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

const post = handlerOf(Route, "POST");

const DID = "did:plc:fake2222222222writer2222";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

async function call(
  body: unknown,
  { authed = true, origin }: { authed?: boolean; origin?: string } = {},
): Promise<Response> {
  return post({
    request: new Request("http://127.0.0.1:3000/api/import/status", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authed
          ? { cookie: `gr_session=${await signSession(DID, SECRET)}` }
          : {}),
        ...(origin ? { origin } : {}),
      },
    }),
  });
}

beforeEach(() => {
  store.selectImportItems.mockReset().mockResolvedValue([]);
  store.selectLiveDraftIds.mockReset().mockResolvedValue([]);
  draftsStore.countDrafts.mockReset().mockResolvedValue([{ n: 3 }]);
  fakeDb.batch.mockClear();
});

describe("/api/import/status — gates", () => {
  it("401s without a session; 403s cross-site", async () => {
    expect(
      (await call({ guidHashes: [hashA] }, { authed: false })).status,
    ).toBe(401);
    expect(
      (await call({ guidHashes: [hashA] }, { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
  });

  it("400s junk: non-hex hashes, empty and oversize lists", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call({ guidHashes: [] })).status).toBe(400);
    expect((await call({ guidHashes: ["not-a-hash"] })).status).toBe(400);
    expect((await call({ guidHashes: [hashA.toUpperCase()] })).status).toBe(
      400,
    );
    expect(
      (await call({ guidHashes: Array.from({ length: 1001 }, () => hashA) }))
        .status,
    ).toBe(400); // over MAX_EXPORT_POSTS
  });
});

describe("/api/import/status — flags + headroom", () => {
  it("marks published and live-draft rows imported; discarded-draft rows not", async () => {
    store.selectImportItems.mockResolvedValue([
      { guidHash: hashA, draftId: null, publishedRkey: "3lzabc" },
      { guidHash: hashB, draftId: "draft-live", publishedRkey: null },
      { guidHash: hashC, draftId: "draft-gone", publishedRkey: null },
    ]);
    store.selectLiveDraftIds.mockResolvedValue([{ id: "draft-live" }]);
    const res = await call({ guidHashes: [hashA, hashB, hashC] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const data = (await res.json()) as {
      ok: boolean;
      draftSlotsRemaining: number;
      alreadyImported: string[];
    };
    expect(data.ok).toBe(true);
    expect(data.draftSlotsRemaining).toBe(47); // 50 - 3
    expect(new Set(data.alreadyImported)).toEqual(new Set([hashA, hashB]));
    // Ownership seam: every store call carried the session DID.
    expect(store.selectImportItems.mock.calls[0][1]).toBe(DID);
    expect(store.selectLiveDraftIds.mock.calls[0][1]).toBe(DID);
  });

  it("chunks ledger lookups under the D1 bound-parameter ceiling", async () => {
    const hashes = Array.from({ length: LEDGER_QUERY_CHUNK * 2 + 7 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const res = await call({ guidHashes: hashes });
    expect(res.status).toBe(200);
    const sizes = store.selectImportItems.mock.calls.map(
      (args) => (args[2] as string[]).length,
    );
    expect(sizes).toEqual([LEDGER_QUERY_CHUNK, LEDGER_QUERY_CHUNK, 7]);
    // ...and all three chunks left in ONE round trip, not three.
    expect(fakeDb.batch).toHaveBeenCalledTimes(1);
    expect((fakeDb.batch.mock.calls[0][0] as unknown[]).length).toBe(3);
  });
});

/**
 * The round-trip budget. Chunking is forced by D1's bound-parameter ceiling;
 * SEQUENCING the chunks is not, and on a 10ms-CPU free-tier worker (50
 * subrequests per request) it was the difference between a working endpoint
 * and a broken one for a genuinely large archive.
 */
describe("/api/import/status — D1 round trips at archive scale", () => {
  const FULL_ARCHIVE = 1000; // MAX_EXPORT_POSTS, the payload ceiling

  it(`costs 3 D1 calls for ${FULL_ARCHIVE} hashes, not one per chunk`, async () => {
    const hashes = Array.from({ length: FULL_ARCHIVE }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    // Worst case for the second phase too: every row is an unpublished import
    // pointing at a distinct draft, so the live-draft lookup also chunks.
    store.selectImportItems.mockImplementation(
      async (_db: unknown, _did: string, keys: string[]) =>
        keys.map((k) => ({
          guidHash: k,
          draftId: `draft-${k}`,
          publishedRkey: null,
        })),
    );
    store.selectLiveDraftIds.mockImplementation(
      async (_db: unknown, _did: string, ids: string[]) =>
        ids.map((id) => ({ id })),
    );

    const res = await call({ guidHashes: hashes });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { alreadyImported: string[] };
    expect(data.alreadyImported).toHaveLength(FULL_ARCHIVE);

    const perChunk = FULL_ARCHIVE / LEDGER_QUERY_CHUNK; // 20 statements a phase
    expect(store.selectImportItems).toHaveBeenCalledTimes(perChunk);
    expect(store.selectLiveDraftIds).toHaveBeenCalledTimes(perChunk);
    // But only two round trips carry all 40 of those statements — one batch per
    // phase (the second phase depends on the first) — plus the draft count.
    expect(fakeDb.batch).toHaveBeenCalledTimes(2);
    expect((fakeDb.batch.mock.calls[0][0] as unknown[]).length).toBe(perChunk);
    expect((fakeDb.batch.mock.calls[1][0] as unknown[]).length).toBe(perChunk);
    expect(draftsStore.countDrafts).toHaveBeenCalledTimes(1);
  });

  it("dedupes draft ids across chunks before spending parameters on them", async () => {
    const hashes = Array.from({ length: LEDGER_QUERY_CHUNK * 3 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    // Every ledger row in every chunk points at the SAME draft.
    store.selectImportItems.mockImplementation(
      async (_db: unknown, _did: string, keys: string[]) =>
        keys.map((k) => ({
          guidHash: k,
          draftId: "one-shared-draft",
          publishedRkey: null,
        })),
    );
    store.selectLiveDraftIds.mockResolvedValue([{ id: "one-shared-draft" }]);

    const res = await call({ guidHashes: hashes });
    expect(res.status).toBe(200);
    // One id, asked for once — not 150 times, and not three times.
    expect(store.selectLiveDraftIds).toHaveBeenCalledTimes(1);
    expect(store.selectLiveDraftIds.mock.calls[0][2]).toEqual([
      "one-shared-draft",
    ]);
    const data = (await res.json()) as { alreadyImported: string[] };
    expect(data.alreadyImported).toHaveLength(hashes.length);
  });

  it("asks D1 nothing extra when no row has an unpublished draft", async () => {
    store.selectImportItems.mockResolvedValue([
      { guidHash: hashA, draftId: null, publishedRkey: "3lzabc" },
    ]);
    const res = await call({ guidHashes: [hashA] });
    expect(res.status).toBe(200);
    // Second phase skipped entirely — no batch with an empty statement list,
    // which the real db.batch() rejects.
    expect(fakeDb.batch).toHaveBeenCalledTimes(1);
    expect(store.selectLiveDraftIds).not.toHaveBeenCalled();
  });
});
