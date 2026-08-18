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
  resolveDidIdentity: vi.fn(),
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
/** A due row as the cron reads it. `announce` is the decision captured when
 * the writer scheduled the post — the cron never re-derives it. */
const POST = { id: "row-1", did: DID, draftId: DRAFT_ID, announce: true };
// biome-ignore lint/suspicious/noExplicitAny: the store calls are all mocked
const db = {} as any;

const draftRow = {
  id: DRAFT_ID,
  did: DID,
  title: "The long way round",
  dek: "",
  content: "[]",
  markdown: "Some words.",
  inlineImages: "",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  restore.mockResolvedValue({ session: true });
  drafts.selectDraft.mockResolvedValue([draftRow]);
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
  publishing.publishStoredDraft.mockResolvedValue({
    ok: true,
    rkey: "3lyk73wxnok2f",
    announce: {
      state: "announced",
      postRkey: "3lz9999999999",
      wroteBack: true,
    },
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
      announceProblem: undefined,
    });
  });

  it("retries when the PDS can't be resolved — somebody else's network", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: "writer.example",
      pds: null,
    });
    const result = await publishDuePost(db, POST);
    expect(result).toMatchObject({ ok: false, retry: true });
    expect(publishing.publishStoredDraft).not.toHaveBeenCalled();
  });

  it("publishes under the DID when the handle won't resolve", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: null,
      pds: "https://pds.example.com",
    });
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

/**
 * Announcing, from a tick with nobody watching.
 *
 * Two rules, and both are about a decision made hours earlier by somebody who
 * has since gone to bed:
 *
 *  1. THE DECISION RIDES THE ROW. The cron publishes what the writer chose when
 *     they scheduled the post, not what their account setting says at 09:00 — a
 *     preference changed on Wednesday for a different post must not reach into
 *     Tuesday's schedule. So nothing on this path may read the writer's
 *     preferences at all, and the value handed down comes from `post.announce`.
 *  2. A FAILURE IS NOT SILENT AND NOT ON THE ROW. The post published; the row is
 *     about to say so. The announce failure therefore travels out as an operator
 *     sentence, because the only other option is a log line at 09:00.
 */
describe("announcing a scheduled post", () => {
  function intentOf(): { requested: boolean; source: string } {
    const input = publishing.publishStoredDraft.mock.calls[0][0] as {
      announce: { requested: boolean; source: string };
    };
    return input.announce;
  }

  it("hands down the decision captured on the row, not a fresh reading", async () => {
    await publishDuePost(db, POST);
    expect(intentOf()).toEqual({ requested: true, source: "schedule" });
  });

  it("stays quiet for a row scheduled with announcing off", async () => {
    await publishDuePost(db, { ...POST, announce: false });
    expect(intentOf()).toEqual({ requested: false, source: "schedule" });
  });

  it("reports nothing when a skip was the point", async () => {
    // "The writer turned it off" and "this was an import" are the guards
    // working. Alerting on those would train an operator to ignore the channel.
    for (const reason of ["not_requested", "imported", "over_budget"]) {
      publishing.publishStoredDraft.mockResolvedValue({
        ok: true,
        rkey: "3lyk73wxnok2f",
        announce: { state: "skipped", reason },
      });
      expect(await publishDuePost(db, POST)).toEqual({
        ok: true,
        rkey: "3lyk73wxnok2f",
        announceProblem: undefined,
      });
    }
  });

  it("surfaces a refused announce as an operator sentence, still reporting the publish", async () => {
    publishing.publishStoredDraft.mockResolvedValue({
      ok: true,
      rkey: "3lyk73wxnok2f",
      announce: {
        state: "failed",
        reason: "refused",
        detail: "InvalidRequest",
      },
    });
    const result = await publishDuePost(db, POST);
    // The post went out. That is not in doubt and must not be reported as
    // anything else — a writer whose post is live must never be told it failed.
    expect(result).toMatchObject({ ok: true, rkey: "3lyk73wxnok2f" });
    expect((result as { announceProblem?: string }).announceProblem).toBe(
      "scheduled post row-1 published but its announce was refused (InvalidRequest)",
    );
  });

  it("names an insufficient grant as such rather than as a rejection", async () => {
    // A grant that predates the Bluesky post scope is fixed by the writer
    // signing in again; a refused record is not. An operator reading one line
    // should not have to guess which of the two they are looking at.
    publishing.publishStoredDraft.mockResolvedValue({
      ok: true,
      rkey: "3lyk73wxnok2f",
      announce: { state: "failed", reason: "scope" },
    });
    const result = (await publishDuePost(db, POST)) as {
      announceProblem?: string;
    };
    expect(result.announceProblem).toMatch(/sign-in predates/i);
  });

  it("surfaces a lost write-back — the state a later duplicate comes from", async () => {
    // The post exists and the document does not reference it, so nothing
    // downstream knows it was announced. Pressing "Announce" then makes a
    // second card, and the create-only scope means nobody here can delete it.
    publishing.publishStoredDraft.mockResolvedValue({
      ok: true,
      rkey: "3lyk73wxnok2f",
      announce: {
        state: "announced",
        postRkey: "3lz9999999999",
        wroteBack: false,
      },
    });
    const result = (await publishDuePost(db, POST)) as {
      announceProblem?: string;
    };
    expect(result.announceProblem).toMatch(/could not be written back/i);
  });
});
