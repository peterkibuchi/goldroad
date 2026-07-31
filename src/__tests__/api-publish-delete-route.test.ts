// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `intent=delete` on /api/publish — the only path that removes a writer's post
 * from their repo.
 *
 * Ownership is structural rather than checked: com.atproto.repo.deleteRecord
 * only reaches records under `repo`, and `repo` here is always the session DID.
 * So what this suite pins is that the handler never lets the form name the repo,
 * that the import ledger is only cleared once the record is actually gone (a
 * ledger cleared on a failed delete would let the same post be imported and
 * published a second time), and that a rejection is reported rather than
 * reading as a deletion.
 */

const atproto = vi.hoisted(() => ({
  resolveDidToHandle: vi.fn(),
  resolveDidToPds: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

const ledger = vi.hoisted(() => ({
  adoptMirror: vi.fn(),
  clearPublishedImport: vi.fn(),
  selectImportItemByDraft: vi.fn(),
  setPublishedRkey: vi.fn(),
}));
vi.mock("~/lib/import-store", () => ledger);

/** Everything the handler does, in order: the XRPC write and the D1 cleanup. */
const steps = vi.hoisted(() => [] as string[]);
type Posted = { nsid: string; options: { input: Record<string, unknown> } };
const posted = vi.hoisted(() => [] as Posted[]);
const postResult = vi.hoisted(() => ({
  current: { ok: true, status: 200, data: {} } as {
    ok: boolean;
    status: number;
    data: Record<string, unknown>;
  },
}));
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, options });
      steps.push(nsid);
      return Promise.resolve(postResult.current);
    }
  },
}));

const restoreFails = vi.hoisted(() => ({ current: false }));
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: () => ({
    restore: () =>
      restoreFails.current
        ? Promise.reject(new Error("no session row"))
        : Promise.resolve({}),
  }),
}));

const DID = "did:plc:fake2222222222writer2222";
const session = vi.hoisted(() => ({ did: "" as string | null }));
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(session.did),
}));

import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const RKEY = "3lyk73wxnok2f";

async function call(
  fields: Record<string, string>,
  headers?: HeadersInit,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return POST({
    request: new Request("https://trygoldroad.com/api/publish", {
      method: "POST",
      body: form,
      headers,
    }),
  });
}

const remove = (over: Record<string, string> = {}, headers?: HeadersInit) =>
  call({ intent: "delete", rkey: RKEY, ...over }, headers);

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "/", "https://trygoldroad.com");
}

function errorFrom(res: Response): string | null {
  return location(res).searchParams.get("error");
}

beforeEach(() => {
  posted.length = 0;
  steps.length = 0;
  postResult.current = { ok: true, status: 200, data: {} };
  restoreFails.current = false;
  session.did = DID;
  for (const fn of Object.values(atproto)) fn.mockReset();
  for (const fn of Object.values(ledger)) fn.mockReset();
  atproto.resolveDidToHandle.mockResolvedValue("writer.example");
  atproto.resolveDidToPds.mockResolvedValue("https://pds.example.com");
  ledger.clearPublishedImport.mockImplementation(async () => {
    steps.push("clearPublishedImport");
    return [];
  });
});

describe("POST /api/publish — intent=delete", () => {
  it("deletes exactly the named document from the writer's own repo", async () => {
    const res = await remove();
    expect(posted).toHaveLength(1);
    expect(posted[0].nsid).toBe("com.atproto.repo.deleteRecord");
    expect(posted[0].options.input).toEqual({
      repo: DID,
      collection: "site.standard.document",
      rkey: RKEY,
    });
    expect(res.status).toBe(303);
    expect(location(res).pathname).toBe("/dashboard");
    expect(location(res).searchParams.get("deleted")).toBe("1");
  });

  it("deletes from the SESSION's repo, never one the form names", async () => {
    // Ownership on this path is the value of `repo` and nothing else, so a form
    // field that reached it would be a delete-anyone's-post bug.
    await remove({
      repo: "did:plc:fake9999999999victim9999",
      did: "did:plc:x",
    });
    expect(posted[0].options.input.repo).toBe(DID);
  });

  it("clears the import ledger only AFTER the record is gone", async () => {
    await remove();
    // The ledger row is what refuses a re-import as a duplicate. Clearing it
    // before the delete lands would offer a live post for import again.
    expect(steps).toEqual([
      "com.atproto.repo.deleteRecord",
      "clearPublishedImport",
    ]);
    expect(ledger.clearPublishedImport).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      RKEY,
    );
  });

  it("LEAVES THE LEDGER ALONE when the PDS refused the delete", async () => {
    postResult.current = {
      ok: false,
      status: 500,
      data: { error: "InternalServerError" },
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await remove();
    quiet.mockRestore();
    // The post is still live. A cleared ledger would let the feed offer it for
    // import again and publish a second copy of it.
    expect(ledger.clearPublishedImport).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("delete_failed:InternalServerError");
    expect(location(res).searchParams.get("deleted")).toBeNull();
  });

  it("tells the writer to re-connect when their grant predates the delete scope", async () => {
    // Sessions created before the delete action was added to the requested
    // scope land here, and a fresh sign-in — not a retry — is the way out.
    for (const status of [401, 403]) {
      ledger.clearPublishedImport.mockClear();
      postResult.current = { ok: false, status, data: {} };
      const res = await remove();
      expect(errorFrom(res)).toBe("delete_scope");
      expect(ledger.clearPublishedImport).not.toHaveBeenCalled();
    }
  });

  it("deletes even when the writer's PDS can't be resolved — this reads nothing", async () => {
    atproto.resolveDidToPds.mockRejectedValue(new Error("no did doc"));
    const res = await remove();
    // The session's own XRPC client already knows where to write; a failed
    // directory lookup must not block a writer removing their own post.
    expect(posted).toHaveLength(1);
    expect(location(res).searchParams.get("deleted")).toBe("1");
  });

  it("still reports the deletion when the ledger cleanup flakes", async () => {
    ledger.clearPublishedImport.mockRejectedValue(new Error("d1 down"));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await remove();
    quiet.mockRestore();
    // The record is already gone — reporting a failure would have the writer
    // hunting a post that no longer exists.
    expect(location(res).searchParams.get("deleted")).toBe("1");
    expect(errorFrom(res)).toBeNull();
  });

  it("refuses a key that is not a record key, and deletes nothing", async () => {
    for (const rkey of ["", ".", "..", "a/b", "with space", "x".repeat(513)]) {
      posted.length = 0;
      const res = await remove({ rkey });
      expect(posted).toHaveLength(0);
      expect(ledger.clearPublishedImport).not.toHaveBeenCalled();
      expect(errorFrom(res)).toBe("missing_rkey");
    }
  });

  it("refuses a cross-site delete before reading the session", async () => {
    const res = await remove({}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(posted).toHaveLength(0);
    expect(atproto.resolveDidToPds).not.toHaveBeenCalled();
  });

  it("refuses a signed-out delete", async () => {
    session.did = null;
    const res = await remove();
    expect(res.status).toBe(401);
    expect(posted).toHaveLength(0);
  });

  it("sends a dead session to sign-in rather than reporting a deletion", async () => {
    restoreFails.current = true;
    const res = await remove();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/write?error=session_expired");
    expect(posted).toHaveLength(0);
  });
});
