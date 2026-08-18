// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduling intents on /api/publish — schedule, unschedule, publish-now.
 *
 * What this suite is really about:
 *
 *  1. THE CONVERSION HAPPENS AT THE WRITE DOOR. A wall-clock time plus the
 *     offset in effect at that moment goes in; one UTC instant is stored. A
 *     missing offset is refused rather than read as "UTC, then", which would
 *     silently shift every schedule by the writer's own offset.
 *  2. SCHEDULING NEVER TOUCHES THE WRITER'S REPO — or their tokens. It must not
 *     restore a session, because a restore refreshes a refresh token, and doing
 *     that to save a date would spend one and widen the race that
 *     ~/lib/scheduled-posts documents.
 *  3. PUBLISH NOW CANNOT RACE THE CRON. The row leaves the queue first, and only
 *     if no tick holds its lease.
 */

const store = vi.hoisted(() => ({
  selectDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock("~/lib/drafts", () => store);

const schedules = vi.hoisted(() => ({
  upsertSchedule: vi.fn(),
  cancelSchedule: vi.fn(),
  deleteSchedulesForDraft: vi.fn(),
  deleteUnclaimedSchedulesForDraft: vi.fn(),
  selectScheduleForDraft: vi.fn(),
}));
vi.mock("~/lib/scheduled-posts", () => schedules);

const publishing = vi.hoisted(() => ({
  publishStoredDraft: vi.fn(),
  resolvePublicationSite: vi.fn(),
  findOwnPublication: vi.fn(),
  announceNewDocument: vi.fn(),
}));
vi.mock("~/lib/publish-document", () => publishing);

/** The announce preference — read only to PRE-FILL a control, never to decide
 * anything on this path. */
const prefs = vi.hoisted(() => ({
  selectWriterPrefs: vi.fn(),
  setAutoAnnounce: vi.fn(),
}));
vi.mock("~/lib/announce-prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/announce-prefs")>()),
  ...prefs,
}));

const atproto = vi.hoisted(() => ({
  resolveDidIdentity: vi.fn(),
  listRecords: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

const restore = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: () => ({ restore }),
}));

const posted = vi.hoisted(() => [] as string[]);
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string) {
      posted.push(nsid);
      return Promise.resolve({ ok: true, data: {} });
    }
  },
}));

const DID = "did:plc:fake2222222222writer2222";
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(DID),
}));

import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const ROW_ID = "99999999-8888-4777-8666-555555555555";
/** Nairobi (UTC+3) reports -180; New York in January reports +300. */
const EAT = "-180";
const NOW = new Date("2026-08-01T07:00:00.000Z");

function draftRow(extra: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    did: DID,
    title: "The long way round",
    dek: "",
    content: "[]",
    markdown: "Some words.",
    inlineImages: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

async function call(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return POST({
    request: new Request("https://trygoldroad.com/api/publish", {
      method: "POST",
      body: form,
    }),
  });
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "/", "https://trygoldroad.com");
}

function errorFrom(res: Response): string | null {
  return location(res).searchParams.get("error");
}

/** The Date the schedule was stored with. */
function scheduledDueAt(): Date {
  const row = schedules.upsertSchedule.mock.calls[0]?.[1] as
    | { dueAt: Date }
    | undefined;
  if (!row) throw new Error("nothing was scheduled");
  return row.dueAt;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  posted.length = 0;
  for (const fn of Object.values(schedules)) fn.mockReset();
  for (const fn of Object.values(publishing)) fn.mockReset();
  for (const fn of Object.values(prefs)) fn.mockReset();
  for (const fn of Object.values(store)) fn.mockReset();
  restore.mockClear();
  store.selectDraft.mockResolvedValue([draftRow()]);
  store.deleteDraft.mockResolvedValue([{ id: DRAFT_ID }]);
  schedules.upsertSchedule.mockResolvedValue([{ id: ROW_ID, dueAt: NOW }]);
  schedules.cancelSchedule.mockResolvedValue([{ id: ROW_ID }]);
  schedules.deleteSchedulesForDraft.mockResolvedValue([{ id: ROW_ID }]);
  schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([
    // `announce` rides out on this RETURNING clause because the row it came
    // from is deleted by the same statement — see the publish-now trap below.
    { id: ROW_ID, status: "failed", announce: true },
  ]);
  schedules.selectScheduleForDraft.mockResolvedValue([]);
  publishing.publishStoredDraft.mockResolvedValue({
    ok: true,
    rkey: "3lyk73wxnok2f",
    announce: { state: "skipped", reason: "not_requested" },
  });
  publishing.announceNewDocument.mockResolvedValue({
    state: "skipped",
    reason: "not_requested",
  });
  prefs.selectWriterPrefs.mockResolvedValue([]);
  prefs.setAutoAnnounce.mockResolvedValue([{ autoAnnounce: true }]);
  // The shared core is mocked here; the interactive publish still calls its
  // site resolution for real, so it needs an answer.
  publishing.resolvePublicationSite.mockResolvedValue({
    site: `at://${DID}/site.standard.publication/3lyk73wxnok2f`,
    publicationUrl: "https://trygoldroad.com/@writer.example",
    ref: {
      uri: `at://${DID}/site.standard.publication/3lyk73wxnok2f`,
      cid: "bafyreipublication",
    },
  });
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("intent=schedule", () => {
  const fields = {
    intent: "schedule",
    draftId: DRAFT_ID,
    dueAtLocal: "2026-08-04T09:00",
    dueTzOffset: EAT,
  };

  it("stores the writer's 9:00 as 06:00 UTC, against their own DID", async () => {
    const res = await call(fields);
    expect(schedules.upsertSchedule).toHaveBeenCalledTimes(1);
    expect(scheduledDueAt().toISOString()).toBe("2026-08-04T06:00:00.000Z");
    const row = schedules.upsertSchedule.mock.calls[0][1] as {
      did: string;
      draftId: string;
      id: string;
    };
    expect(row.did).toBe(DID); // session identity, never client-supplied
    expect(row.draftId).toBe(DRAFT_ID);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.status).toBe(303);
  });

  it("converts the other sign correctly too", async () => {
    await call({
      ...fields,
      dueAtLocal: "2026-12-13T09:00",
      dueTzOffset: "300",
    });
    expect(scheduledDueAt().toISOString()).toBe("2026-12-13T14:00:00.000Z");
  });

  it("lands the writer on the queue, where the answer to 'is it going out' is", async () => {
    const res = await call(fields);
    const url = location(res);
    expect(url.pathname).toBe("/dashboard");
    expect(url.searchParams.get("tab")).toBe("scheduled");
    expect(url.searchParams.get("scheduled")).toBe("1");
  });

  it("NEVER restores the session — no repo write, no token refresh", async () => {
    await call(fields);
    expect(restore).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it("refuses a submission with no zone offset instead of assuming UTC", async () => {
    const { dueTzOffset: _dropped, ...noOffset } = fields;
    const res = await call(noOffset);
    expect(schedules.upsertSchedule).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("schedule_invalid");
  });

  it("refuses an implausible offset", async () => {
    const res = await call({ ...fields, dueTzOffset: "900" });
    expect(schedules.upsertSchedule).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("schedule_invalid");
  });

  it("refuses a time that has already passed", async () => {
    const res = await call({ ...fields, dueAtLocal: "2026-07-01T09:00" });
    expect(schedules.upsertSchedule).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("schedule_past");
  });

  it("refuses a time past the horizon", async () => {
    const res = await call({ ...fields, dueAtLocal: "2031-08-04T09:00" });
    expect(errorFrom(res)).toBe("schedule_too_far");
  });

  it("refuses a draft that isn't the writer's — the store's empty result", async () => {
    // "missing" and "not yours" are deliberately the same answer.
    store.selectDraft.mockResolvedValue([]);
    const res = await call(fields);
    expect(schedules.upsertSchedule).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("schedule_no_draft");
  });

  it("reads the draft with the SESSION did, never a client-supplied one", async () => {
    await call(fields);
    expect(store.selectDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
  });

  it("refuses an untitled draft NOW rather than failing at 09:00 tomorrow", async () => {
    store.selectDraft.mockResolvedValue([draftRow({ title: "   " })]);
    const res = await call(fields);
    expect(schedules.upsertSchedule).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("missing_title");
  });

  it("sends the writer back to the DRAFT on failure, never to a blank editor", async () => {
    store.selectDraft.mockResolvedValue([]);
    const url = location(await call(fields));
    expect(url.pathname).toBe("/write");
    expect(url.searchParams.get("draft")).toBe(DRAFT_ID);
  });

  it("refuses a malformed draft id without touching the store", async () => {
    const res = await call({ ...fields, draftId: "not-a-uuid" });
    expect(store.selectDraft).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("schedule_no_draft");
  });

  it("reports a failed write instead of claiming a schedule", async () => {
    schedules.upsertSchedule.mockRejectedValue(new Error("d1 down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorFrom(await call(fields))).toBe("schedule_failed");
    quiet.mockRestore();
  });
});

describe("intent=unschedule", () => {
  it("cancels by the schedule's own id, scoped to the writer", async () => {
    const res = await call({ intent: "unschedule", id: ROW_ID });
    expect(schedules.cancelSchedule).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      ROW_ID,
    );
    expect(location(res).searchParams.get("unscheduled")).toBe("1");
  });

  it("cancels by draft id when that is all the caller has", async () => {
    const res = await call({ intent: "unschedule", draftId: DRAFT_ID });
    expect(schedules.deleteSchedulesForDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
    expect(location(res).pathname).toBe("/dashboard");
  });

  it("returns to the editor when that is where the cancel came from", async () => {
    const res = await call({
      intent: "unschedule",
      id: ROW_ID,
      draftId: DRAFT_ID,
      returnTo: "write",
    });
    const url = location(res);
    expect(url.pathname).toBe("/write");
    expect(url.searchParams.get("draft")).toBe(DRAFT_ID);
    expect(url.searchParams.get("unscheduled")).toBe("1");
  });

  it("reports success when nothing matched — the row is gone either way", async () => {
    schedules.cancelSchedule.mockResolvedValue([]);
    const res = await call({ intent: "unschedule", id: ROW_ID });
    expect(errorFrom(res)).toBeNull();
  });

  it("never restores the session either", async () => {
    await call({ intent: "unschedule", id: ROW_ID });
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("intent=publish-now", () => {
  const fields = { intent: "publish-now", draftId: DRAFT_ID };

  it("takes the row out of the queue BEFORE publishing anything", async () => {
    const order: string[] = [];
    schedules.deleteUnclaimedSchedulesForDraft.mockImplementation(async () => {
      order.push("dequeue");
      return [{ id: ROW_ID, status: "failed", announce: true }];
    });
    publishing.publishStoredDraft.mockImplementation(async () => {
      order.push("publish");
      return {
        ok: true,
        rkey: "3lyk73wxnok2f",
        announce: { state: "skipped", reason: "not_requested" },
      };
    });
    await call(fields);
    // A row that no longer exists cannot be claimed by a tick a moment later.
    // The other order publishes twice.
    expect(order).toEqual(["dequeue", "publish"]);
    expect(schedules.deleteUnclaimedSchedulesForDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
  });

  it("publishes through the same core the cron uses, and reports the rkey", async () => {
    const res = await call(fields);
    expect(publishing.publishStoredDraft).toHaveBeenCalledTimes(1);
    const input = publishing.publishStoredDraft.mock.calls[0][0] as {
      did: string;
      draft: { id: string };
    };
    expect(input.did).toBe(DID);
    expect(input.draft.id).toBe(DRAFT_ID);
    expect(location(res).searchParams.get("published")).toBe("3lyk73wxnok2f");
  });

  it("REFUSES when a tick already holds the lease — mid-publish is not a retry", async () => {
    schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([]);
    schedules.selectScheduleForDraft.mockResolvedValue([
      { id: ROW_ID, status: "pending", dueAt: NOW, claimedAt: NOW },
    ]);
    const res = await call(fields);
    expect(publishing.publishStoredDraft).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("schedule_in_flight");
  });

  it("still publishes a draft that has no schedule at all", async () => {
    // Nothing to dequeue is not an error: this is also "publish this draft".
    schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([]);
    schedules.selectScheduleForDraft.mockResolvedValue([]);
    const res = await call(fields);
    expect(publishing.publishStoredDraft).toHaveBeenCalledTimes(1);
    expect(location(res).searchParams.get("published")).toBe("3lyk73wxnok2f");
  });

  it("surfaces the publish failure's own code", async () => {
    publishing.publishStoredDraft.mockResolvedValue({
      ok: false,
      retry: false,
      reason: "Your data server refused the post (InvalidRequest).",
      code: "publish_failed:InvalidRequest",
    });
    const res = await call(fields);
    expect(errorFrom(res)).toBe("publish_failed:InvalidRequest");
  });

  it("says so when the draft is gone", async () => {
    store.selectDraft.mockResolvedValue([]);
    const res = await call(fields);
    expect(publishing.publishStoredDraft).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("draft_not_found");
  });

  it("does restore the session — this one really does write a record", async () => {
    await call(fields);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe("intent=document — pressing Publish on a post you had scheduled", () => {
  it("clears the schedule with the draft, so no tick fails a live post", async () => {
    // Publishing a scheduled draft by hand IS a decision to publish it. A
    // surviving row would have the next tick find the draft gone and report a
    // failure for a post the writer can already read.
    atproto.listRecords.mockResolvedValue([]);
    const res = await call({
      title: "The long way round",
      body: "Some words.",
      draftId: DRAFT_ID,
    });
    expect(res.status).toBe(303);
    expect(store.deleteDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
    expect(schedules.deleteSchedulesForDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
  });
});

/**
 * The announce decision, captured when the writer schedules and read back out
 * when something publishes.
 *
 * WHY IT IS CAPTURED AT ALL. Everything else about a scheduled post is a
 * reference to a draft, so editing the draft changes what goes out — which is
 * what a writer means by "this piece publishes on Tuesday". Whether it reaches
 * their followers is different: they decided that with this post in front of
 * them, and a cron re-reading their account setting at 09:00 would apply a
 * preference they may have changed on Wednesday, for a different post, to this
 * one.
 */
describe("the announce decision on a schedule", () => {
  const fields = {
    intent: "schedule",
    draftId: DRAFT_ID,
    dueAtLocal: "2026-08-04T09:00",
    dueTzOffset: EAT,
  };

  function capturedAnnounce(): boolean {
    const row = schedules.upsertSchedule.mock.calls[0]?.[1] as
      | { announce?: boolean }
      | undefined;
    if (!row) throw new Error("nothing was scheduled");
    return row.announce as boolean;
  }

  it("stores the decision the publish surface submitted", async () => {
    await call({ ...fields, announce: "1" });
    expect(capturedAnnounce()).toBe(true);
  });

  it("stores an explicit no as a no", async () => {
    await call({ ...fields, announce: "0" });
    expect(capturedAnnounce()).toBe(false);
  });

  it("reads a MISSING decision as no, never as the account setting", async () => {
    // Every surface that can schedule renders the checkbox, so nothing legitimate
    // omits the field. Falling back to the account setting here would let a
    // caller announce by omission, and "scheduling quietly posted to my
    // followers" is the one failure this feature cannot afford.
    await call(fields);
    expect(capturedAnnounce()).toBe(false);
    expect(prefs.selectWriterPrefs).not.toHaveBeenCalled();
  });

  it("never restores a session to save it", async () => {
    // Still true with the new field: this writes one row in our own database.
    await call({ ...fields, announce: "1" });
    expect(restore).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });
});

/**
 * THE TRAP, pinned. "Publish now" deletes the schedule row before it reads the
 * draft, because delete-first is the entire double-publish guard on that path.
 * The announce decision lives on that row — so it has to leave on the delete's
 * RETURNING clause, or it is gone by the time anything could ask for it.
 *
 * A test that only checked "the right value was used" would pass against a
 * lookup placed after the delete on a mock that still answers. So these check
 * the value AND that no second lookup was made.
 */
describe("intent=publish-now — the captured decision survives the delete", () => {
  const fields = { intent: "publish-now", draftId: DRAFT_ID };

  function intentOf(): { requested: boolean; source: string } {
    const input = publishing.publishStoredDraft.mock.calls[0][0] as {
      announce: { requested: boolean; source: string };
    };
    return input.announce;
  }

  it("publishes with the decision the deleted row was carrying", async () => {
    schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([
      { id: ROW_ID, status: "pending", announce: true },
    ]);
    await call(fields);
    expect(intentOf()).toEqual({ requested: true, source: "publish-now" });
    // The row was the only source. Asking the account setting instead would
    // publish a preference the writer never applied to this post.
    expect(prefs.selectWriterPrefs).not.toHaveBeenCalled();
  });

  it("honours a row that captured 'no', even when the account setting says yes", async () => {
    prefs.selectWriterPrefs.mockResolvedValue([{ autoAnnounce: true }]);
    schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([
      { id: ROW_ID, status: "pending", announce: false },
    ]);
    await call(fields);
    expect(intentOf().requested).toBe(false);
    expect(prefs.selectWriterPrefs).not.toHaveBeenCalled();
  });

  it("falls back to the account setting ONLY when there was no row to capture from", async () => {
    // A plain draft published this way never had a decision captured for it, and
    // the writer is pressing the button in front of us — which is exactly the
    // situation the cron is never in.
    schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([]);
    schedules.selectScheduleForDraft.mockResolvedValue([]);
    prefs.selectWriterPrefs.mockResolvedValue([{ autoAnnounce: false }]);
    await call(fields);
    expect(prefs.selectWriterPrefs).toHaveBeenCalledTimes(1);
    expect(intentOf().requested).toBe(false);
  });

  it("treats no row and no readable setting as the default: on", async () => {
    schedules.deleteUnclaimedSchedulesForDraft.mockResolvedValue([]);
    schedules.selectScheduleForDraft.mockResolvedValue([]);
    prefs.selectWriterPrefs.mockRejectedValue(new Error("d1 down"));
    await call(fields);
    expect(intentOf().requested).toBe(true);
  });

  it("names the announced post in the redirect when the publish announced it", async () => {
    publishing.publishStoredDraft.mockResolvedValue({
      ok: true,
      rkey: "3lyk73wxnok2f",
      announce: {
        state: "announced",
        postRkey: "3lz9999999999",
        wroteBack: true,
      },
    });
    const res = await call(fields);
    expect(location(res).searchParams.get("published")).toBe("3lyk73wxnok2f");
    expect(location(res).searchParams.get("announced")).toBe("3lz9999999999");
  });

  it("says the post is live and the announce is not, rather than reporting a failure", async () => {
    publishing.publishStoredDraft.mockResolvedValue({
      ok: true,
      rkey: "3lyk73wxnok2f",
      announce: {
        state: "failed",
        reason: "refused",
        detail: "InvalidRequest",
      },
    });
    const res = await call(fields);
    const url = location(res);
    expect(url.searchParams.get("published")).toBe("3lyk73wxnok2f");
    expect(url.searchParams.get("announceFailed")).toBe("announce_failed");
    // NOT `error=`: the publish succeeded, and a writer whose post is live must
    // never be told it failed.
    expect(url.searchParams.get("error")).toBeNull();
  });

  it("names an insufficient grant separately, so the page can offer re-connect", async () => {
    publishing.publishStoredDraft.mockResolvedValue({
      ok: true,
      rkey: "3lyk73wxnok2f",
      announce: { state: "failed", reason: "scope" },
    });
    const res = await call(fields);
    expect(location(res).searchParams.get("announceFailed")).toBe(
      "announce_scope",
    );
  });

  it("says nothing at all when announcing was simply off", async () => {
    const res = await call(fields);
    const url = location(res);
    expect(url.searchParams.get("published")).toBe("3lyk73wxnok2f");
    expect(url.searchParams.get("announced")).toBeNull();
    expect(url.searchParams.get("announceFailed")).toBeNull();
  });
});
