// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/drafts handler behavior: session gate, the pre-parse byte cap, payload
 * validation, the create cap, upsert semantics, and the no-store guarantee.
 * The store (~/lib/drafts) is mocked — its SQL-level ownership enforcement is
 * pinned separately in drafts.test.ts; here we assert the handler always
 * routes the SESSION DID (never anything client-supplied) into that store.
 */
const store = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  selectDraft: vi.fn(),
  countDrafts: vi.fn(),
  insertDraft: vi.fn(),
  updateDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock("~/lib/drafts", () => store);

import { MAX_DRAFT_BODY_BYTES } from "../lib/drafts-schema";
import { signSession } from "../lib/session";
import { Route } from "../routes/api.drafts";

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const handlers = (
  Route.options as unknown as {
    server: {
      handlers: { GET: Handler; POST: Handler; DELETE: Handler };
    };
  }
).server.handlers;

const DID = "did:plc:fake2222222222writer2222";
const ID = "11111111-2222-3333-4444-555555555555";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers
const NOW = new Date("2026-07-27T12:00:00.000Z");

async function sessionCookie(): Promise<string> {
  return `gr_session=${await signSession(DID, SECRET)}`;
}

async function call(
  method: "GET" | "POST" | "DELETE",
  qs = "",
  body?: string,
  authed = true,
): Promise<Response> {
  const request = new Request(`http://127.0.0.1:3000/api/drafts${qs}`, {
    method,
    ...(body !== undefined ? { body } : {}),
    headers: {
      ...(authed ? { cookie: await sessionCookie() } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
  });
  return handlers[method]({ request });
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
});

describe("session gate", () => {
  it("401s every method without a session — and never touches the store", async () => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await call(
        method,
        "",
        method === "POST" ? "{}" : undefined,
        false,
      );
      expect(res.status).toBe(401);
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it("403s cross-site mutations (Origin mismatch) even with a valid session", async () => {
    for (const [method, body] of [
      ["POST", "{}"],
      ["DELETE", undefined],
    ] as const) {
      const request = new Request(`http://127.0.0.1:3000/api/drafts?id=${ID}`, {
        method,
        ...(body !== undefined ? { body } : {}),
        headers: {
          cookie: await sessionCookie(),
          origin: "https://evil.example",
        },
      });
      const res = await handlers[method]({ request });
      expect(res.status).toBe(403);
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("GET — list and get-one", () => {
  it("lists my drafts (metadata only) and queries with the session DID", async () => {
    store.listDrafts.mockResolvedValue([
      { id: ID, title: "Hello", createdAt: NOW, updatedAt: NOW },
    ]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(store.listDrafts).toHaveBeenCalledWith(expect.anything(), DID);
    const data = (await res.json()) as {
      drafts: { id: string; title: string; updatedAt: string }[];
    };
    expect(data.drafts).toEqual([
      {
        id: ID,
        title: "Hello",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  it("returns one draft with parsed block content", async () => {
    store.selectDraft.mockResolvedValue([
      {
        id: ID,
        did: DID,
        title: "Hello",
        content: '[{"type":"paragraph"}]',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await call("GET", `?id=${ID}`);
    expect(store.selectDraft).toHaveBeenCalledWith(expect.anything(), DID, ID);
    const data = (await res.json()) as { draft: { content: unknown } };
    expect(data.draft.content).toEqual([{ type: "paragraph" }]);
  });

  it("nulls the content of a corrupt row instead of failing the resume", async () => {
    store.selectDraft.mockResolvedValue([
      {
        id: ID,
        did: DID,
        title: "",
        content: "{oops",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await call("GET", `?id=${ID}`);
    const data = (await res.json()) as { draft: { content: unknown } };
    expect(data.draft.content).toBeNull();
  });

  it("404s a missing/foreign draft, and a malformed id without a query", async () => {
    store.selectDraft.mockResolvedValue([]);
    expect((await call("GET", `?id=${ID}`)).status).toBe(404);
    expect((await call("GET", "?id=not-a-uuid")).status).toBe(404);
    expect(store.selectDraft).toHaveBeenCalledTimes(1);
  });
});

describe("POST — upsert", () => {
  const payload = (id?: string) =>
    JSON.stringify({ id, title: "Hi", content: [{ type: "paragraph" }] });

  it("creates under the cap: 201 with the minted id, content re-serialized", async () => {
    store.countDrafts.mockResolvedValue([{ n: 0 }]);
    store.insertDraft.mockImplementation(
      async (_db: unknown, row: { id: string }) => [
        { id: row.id, updatedAt: NOW },
      ],
    );
    const res = await call("POST", "", payload());
    expect(res.status).toBe(201);
    expect(store.insertDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        did: DID, // session identity, never client-supplied
        title: "Hi",
        content: '[{"type":"paragraph"}]',
      }),
    );
    const data = (await res.json()) as { draft: { id: string } };
    expect(data.draft.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects creates at the cap with draft_limit (409); nothing inserted", async () => {
    store.countDrafts.mockResolvedValue([{ n: 50 }]);
    const res = await call("POST", "", payload());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("draft_limit");
    expect(store.insertDraft).not.toHaveBeenCalled();
  });

  it("updates my draft when the id is mine (store scoped by session DID)", async () => {
    store.updateDraft.mockResolvedValue([{ id: ID, updatedAt: NOW }]);
    const res = await call("POST", "", payload(ID));
    expect(res.status).toBe(200);
    expect(store.updateDraft).toHaveBeenCalledWith(expect.anything(), DID, ID, {
      title: "Hi",
      content: '[{"type":"paragraph"}]',
    });
    expect(store.countDrafts).not.toHaveBeenCalled(); // cap is create-only
  });

  it("404s an update of a missing/foreign draft — same answer for both", async () => {
    store.updateDraft.mockResolvedValue([]);
    expect((await call("POST", "", payload(ID))).status).toBe(404);
  });

  it("413s an oversized body BEFORE parsing (no store call, no JSON.parse)", async () => {
    const big = `{"title":"x","content":["${"a".repeat(MAX_DRAFT_BODY_BYTES)}"]}`;
    const res = await call("POST", "", big);
    expect(res.status).toBe(413);
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it("400s malformed JSON and wrong shapes", async () => {
    expect((await call("POST", "", "{not json")).status).toBe(400);
    expect(
      (await call("POST", "", JSON.stringify({ title: "x", content: "s" })))
        .status,
    ).toBe(400);
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("DELETE", () => {
  it("deletes my draft", async () => {
    store.deleteDraft.mockResolvedValue([{ id: ID }]);
    const res = await call("DELETE", `?id=${ID}`);
    expect(res.status).toBe(200);
    expect(store.deleteDraft).toHaveBeenCalledWith(expect.anything(), DID, ID);
  });

  it("404s missing/foreign drafts and malformed ids", async () => {
    store.deleteDraft.mockResolvedValue([]);
    expect((await call("DELETE", `?id=${ID}`)).status).toBe(404);
    expect((await call("DELETE", "?id=junk")).status).toBe(404);
    expect(store.deleteDraft).toHaveBeenCalledTimes(1);
  });
});

describe("caching", () => {
  it("every response is no-store — drafts are private data", async () => {
    store.listDrafts.mockResolvedValue([]);
    store.deleteDraft.mockResolvedValue([]);
    const responses = [
      await call("GET"),
      await call("POST", "", "{not json"),
      await call("DELETE", "?id=junk"),
      await call("GET", "", undefined, false),
    ];
    for (const res of responses) {
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
