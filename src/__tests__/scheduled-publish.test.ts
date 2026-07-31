// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cron's publisher — the module that turns one claimed row into a record in
 * a writer's repo, hours after the writer walked away.
 *
 * THE CASE THIS SUITE EXISTS FOR is the first one: `client.restore(did)`
 * throwing. A revoked or expired refresh grant cannot be fixed by trying again
 * in an hour, so the post must FAIL — with a sentence the writer can read and
 * act on — rather than sit "pending" while its moment passes. A scheduled post
 * that silently never went out is the worst outcome this feature has, because
 * the writer believes they published.
 */
const restore = vi.hoisted(() => vi.fn());
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: vi.fn(() => ({ restore })),
}));

const drafts = vi.hoisted(() => ({ selectDraft: vi.fn() }));
vi.mock("~/lib/drafts", () => drafts);

const atproto = vi.hoisted(() => ({
  resolveDidToHandle: vi.fn(),
  resolveDidToPds: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

const publishing = vi.hoisted(() => ({ publishStoredDraft: vi.fn() }));
vi.mock("~/lib/publish-document", () => publishing);

vi.mock("@atcute/client", () => ({
  Client: class {
    constructor(readonly options: unknown) {}
  },
}));

import { createOAuthClient } from "../lib/oauth";
import { CANONICAL_ORIGIN } from "../lib/origin";
import {
  DRAFT_GONE_REASON,
  publishDuePost,
  SESSION_LOST_REASON,
} from "../lib/scheduled-publish";

const DID = "did:plc:fake2222222222writer2222";
const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const POST = { id: "row-1", did: DID, draftId: DRAFT_ID };
// biome-ignore lint/suspicious/noExplicitAny: the store calls are all mocked
const db = {} as any;

const draftRow = {
  id: DRAFT_ID,
  did: DID,
  title: "The long way round",
  dek: "",
  content: "[]",
  markdown: "Some words.",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  restore.mockResolvedValue({ session: true });
  drafts.selectDraft.mockResolvedValue([draftRow]);
  atproto.resolveDidToHandle.mockResolvedValue("writer.example");
  atproto.resolveDidToPds.mockResolvedValue("https://pds.example.com");
  publishing.publishStoredDraft.mockResolvedValue({
    ok: true,
    rkey: "3lyk73wxnok2f",
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a session that can no longer be restored", () => {
  it("FAILS the post — terminally — with a reason the writer can act on", async () => {
    restore.mockRejectedValue(new Error("invalid_grant"));
    const result = await publishDuePost(db, POST);
    expect(result).toEqual({
      ok: false,
      retry: false,
      reason: SESSION_LOST_REASON,
    });
    // Not "try again in an hour": an hour changes nothing about a revoked
    // grant, and three more silent hours is three more hours of the writer
    // believing they published.
    expect(result).not.toMatchObject({ retry: true });
  });

  it("names the cause, the consequence and the fix in that reason", async () => {
    expect(SESSION_LOST_REASON).toMatch(/did not go out/i);
    expect(SESSION_LOST_REASON).toMatch(/expired|revoked/i);
    expect(SESSION_LOST_REASON).toMatch(/sign in again/i);
    // Never a stack trace or an error code: this string is shown verbatim.
    expect(SESSION_LOST_REASON).not.toMatch(/invalid_grant|401|undefined/);
  });

  it("never reads the draft or writes a record after a failed restore", async () => {
    restore.mockRejectedValue(new Error("invalid_grant"));
    await publishDuePost(db, POST);
    expect(drafts.selectDraft).not.toHaveBeenCalled();
    expect(publishing.publishStoredDraft).not.toHaveBeenCalled();
  });
});

describe("reading the draft", () => {
  it("reads it with the ROW's own DID — the cross-writer query ends here", async () => {
    await publishDuePost(db, POST);
    expect(drafts.selectDraft).toHaveBeenCalledWith(db, DID, DRAFT_ID);
  });

  it("fails the post when the draft is gone — nothing to publish, ever", async () => {
    drafts.selectDraft.mockResolvedValue([]);
    expect(await publishDuePost(db, POST)).toEqual({
      ok: false,
      retry: false,
      reason: DRAFT_GONE_REASON,
    });
  });

  it("retries a failed READ — a D1 blip is not a verdict on the post", async () => {
    drafts.selectDraft.mockRejectedValue(new Error("d1 down"));
    const result = await publishDuePost(db, POST);
    expect(result).toMatchObject({ ok: false, retry: true });
  });
});

describe("publishing", () => {
  it("mints URLs from the canonical origin — there is no request to read one from", async () => {
    await publishDuePost(db, POST);
    expect(createOAuthClient).toHaveBeenCalledWith(CANONICAL_ORIGIN);
    const input = publishing.publishStoredDraft.mock.calls[0][0] as {
      origin: string;
      ident: string;
      draft: { id: string };
    };
    expect(input.origin).toBe(CANONICAL_ORIGIN);
    expect(input.ident).toBe("writer.example");
    expect(input.draft.id).toBe(DRAFT_ID);
  });

  it("reports the rkey on success", async () => {
    expect(await publishDuePost(db, POST)).toEqual({
      ok: true,
      rkey: "3lyk73wxnok2f",
    });
  });

  it("retries when the PDS can't be resolved — somebody else's network", async () => {
    atproto.resolveDidToPds.mockRejectedValue(new Error("dns"));
    const result = await publishDuePost(db, POST);
    expect(result).toMatchObject({ ok: false, retry: true });
    expect(publishing.publishStoredDraft).not.toHaveBeenCalled();
  });

  it("publishes under the DID when the handle won't resolve", async () => {
    atproto.resolveDidToHandle.mockRejectedValue(new Error("dns"));
    await publishDuePost(db, POST);
    const input = publishing.publishStoredDraft.mock.calls[0][0] as {
      ident: string;
    };
    expect(input.ident).toBe(DID);
  });

  it("passes the core's own verdict straight through", async () => {
    publishing.publishStoredDraft.mockResolvedValue({
      ok: false,
      retry: true,
      reason: "Your data server couldn't take the post just now (Timeout).",
      code: "publish_failed:Timeout",
    });
    expect(await publishDuePost(db, POST)).toEqual({
      ok: false,
      retry: true,
      reason: "Your data server couldn't take the post just now (Timeout).",
    });
  });

  it("refuses a row whose DID is not a DID, without touching OAuth", async () => {
    const result = await publishDuePost(db, { ...POST, did: "not-a-did" });
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(createOAuthClient).not.toHaveBeenCalled();
  });
});
