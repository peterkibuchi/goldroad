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

vi.mock("drizzle-orm/d1", () => ({ drizzle: () => ({}) }));

import { LEDGER_QUERY_CHUNK } from "../lib/import-flags";
import { signSession } from "../lib/session";
import { Route } from "../routes/api.import.status";

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const post = (
  Route.options as unknown as { server: { handlers: { POST: Handler } } }
).server.handlers.POST;

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
    expect(res.headers.get("cache-control")).toBe("no-store");
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
  });
});
