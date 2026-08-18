// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `intent=document` on /api/publish — the primary publish path, and the handler
 * rather than the record builders underneath it.
 *
 * What this pins is the handler's own work: the order it does things in, and
 * what survives when a step fails.
 *
 *  1. THE COVER BLOB IS UPLOADED BEFORE THE RECORD IS WRITTEN. A record
 *     reference is the only thing that stops the PDS reclaiming a blob, so the
 *     other order publishes a post whose cover disappears.
 *  2. THE PUBLICATION IS RESOLVED BEFORE THE DOCUMENT, and the document's `site`
 *     is what that resolution returned — a writer with no publication yet gets
 *     one created first, and a writer whose PDS can't be reached publishes a
 *     loose document rather than being refused.
 *  3. THE REDIRECT NAMES THE KEY THE RECORD WAS WRITTEN UNDER. `?published=` is
 *     what the dashboard's "view it live" link is built from; a mismatch between
 *     it, the createRecord rkey, and the record's own `path` is a 404 the writer
 *     finds by clicking.
 *  4. A FAILED PUBLISH LEAVES THE DRAFT ALONE. The draft row is the only copy of
 *     the writer's words at that moment, and it is removed only once the record
 *     has landed.
 */

const atproto = vi.hoisted(() => ({
  resolveDidIdentity: vi.fn(),
  listRecords: vi.fn(),
  getRecordEntry: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

const drafts = vi.hoisted(() => ({
  selectDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock("~/lib/drafts", () => drafts);

const schedules = vi.hoisted(() => ({
  cancelSchedule: vi.fn(),
  deleteSchedulesForDraft: vi.fn(),
  deleteUnclaimedSchedulesForDraft: vi.fn(),
  selectScheduleForDraft: vi.fn(),
  upsertSchedule: vi.fn(),
}));
vi.mock("~/lib/scheduled-posts", () => schedules);

const ledger = vi.hoisted(() => ({
  adoptMirror: vi.fn(),
  clearPublishedImport: vi.fn(),
  selectImportItemByDraft: vi.fn(),
  setPublishedRkey: vi.fn(),
}));
vi.mock("~/lib/import-store", () => ledger);

/** The XRPC calls the handler makes, in order — nsid plus what it sent. */
type Posted = {
  nsid: string;
  options: { input: Record<string, unknown> };
};
const posted = vi.hoisted(() => [] as Posted[]);
/** Everything the handler observes, in one ordered list: the XRPC writes above
 * plus the D1 side effects, so "before"/"after" is assertable across both. */
const steps = vi.hoisted(() => [] as string[]);
type Reply = { ok: boolean; status: number; data: Record<string, unknown> };
const replies = vi.hoisted(() => new Map<string, Reply>());
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, options });
      const collection = options?.input?.collection;
      steps.push(
        typeof collection === "string" ? `${nsid}:${collection}` : nsid,
      );
      return Promise.resolve(
        replies.get(nsid) ?? { ok: true, status: 200, data: {} },
      );
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

import { generateTid, MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "../lib/publish";
import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const PUB_RKEY = "3lyk73wxnok2f";
const PUB_URI = `at://${DID}/site.standard.publication/${PUB_RKEY}`;
const CID = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The writer's publication as their PDS lists it. */
function publication(extra: Record<string, unknown> = {}) {
  return {
    uri: PUB_URI,
    cid: "bafyreipublication",
    value: {
      $type: "site.standard.publication",
      name: "The Long Way",
      url: "https://trygoldroad.com/@writer.example",
      ...extra,
    },
  };
}

const blob = (over: Record<string, unknown> = {}) => ({
  $type: "blob",
  ref: { $link: CID },
  mimeType: "image/jpeg",
  size: 1234,
  ...over,
});

const png = (bytes = 64, type = "image/png") =>
  new File([new Uint8Array(bytes)], "cover.png", { type });

async function call(
  fields: Record<string, string | File>,
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

const publish = (
  over: Record<string, string | File> = {},
  headers?: HeadersInit,
) =>
  call({ title: "The long way round", body: "Some words.", ...over }, headers);

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "/", "https://trygoldroad.com");
}

function errorFrom(res: Response): string | null {
  return location(res).searchParams.get("error");
}

function callOf(nsid: string, collection?: string): Posted | undefined {
  return posted.find(
    (p) =>
      p.nsid === nsid &&
      (collection === undefined || p.options.input.collection === collection),
  );
}

/** The document record the handler built and sent. */
function documentRecord(): Record<string, unknown> {
  const created = callOf(
    "com.atproto.repo.createRecord",
    "site.standard.document",
  );
  const record = created?.options.input.record;
  if (!record) throw new Error("no document record was written");
  return record as Record<string, unknown>;
}

beforeEach(() => {
  posted.length = 0;
  steps.length = 0;
  replies.clear();
  session.did = DID;
  restoreFails.current = false;
  for (const fn of Object.values(atproto)) fn.mockReset();
  for (const fn of Object.values(drafts)) fn.mockReset();
  for (const fn of Object.values(schedules)) fn.mockReset();
  for (const fn of Object.values(ledger)) fn.mockReset();
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
  atproto.listRecords.mockResolvedValue([publication()]);
  drafts.deleteDraft.mockImplementation(async () => {
    steps.push("deleteDraft");
    return [{ id: DRAFT_ID }];
  });
  schedules.deleteSchedulesForDraft.mockImplementation(async () => {
    steps.push("deleteSchedulesForDraft");
    return [];
  });
  // No import provenance unless a test says otherwise.
  ledger.selectImportItemByDraft.mockResolvedValue([]);
  ledger.setPublishedRkey.mockResolvedValue([]);
  ledger.adoptMirror.mockResolvedValue([]);
});

describe("POST /api/publish — intent=document, publishing a new post", () => {
  it("writes ONE document record into the writer's own repo", async () => {
    const res = await publish();

    const created = callOf(
      "com.atproto.repo.createRecord",
      "site.standard.document",
    );
    expect(created).toBeDefined();
    expect(created?.options.input.repo).toBe(DID);
    // The writer already has a publication, so the document is the only write.
    expect(posted).toHaveLength(1);
    expect(res.status).toBe(303);
  });

  it("attaches the document to the publication it resolved, by AT-URI", async () => {
    await publish();
    // An at:// site is what makes the post part of the publication rather than
    // a loose document — and what the announce path follows to build a card.
    expect(documentRecord().site).toBe(PUB_URI);
  });

  it("keeps the redirect, the record key, and the record's path in step", async () => {
    // These three are the same key seen three ways. The dashboard builds "view
    // it live" from the redirect and the reader resolves the record by key, so
    // any disagreement here is a 404 the writer finds by clicking.
    const res = await publish();
    const rkey = callOf(
      "com.atproto.repo.createRecord",
      "site.standard.document",
    )?.options.input.rkey;
    expect(typeof rkey).toBe("string");
    expect(documentRecord().path).toBe(`/${rkey}`);
    expect(location(res).pathname).toBe("/dashboard");
    expect(location(res).searchParams.get("published")).toBe(rkey);
  });

  it("carries the writer's words and subtitle into the record", async () => {
    await publish({ body: "Some words.", dek: "A subtitle they wrote." });
    const record = documentRecord();
    expect(record.$type).toBe("site.standard.document");
    expect(record.title).toBe("The long way round");
    expect(record.textContent).toBe("Some words.");
    expect(record.description).toBe("A subtitle they wrote.");
    expect(typeof record.publishedAt).toBe("string");
  });

  it("creates the writer's first publication BEFORE the post that needs it", async () => {
    atproto.listRecords.mockResolvedValue([]);
    await publish();
    // A document written first would reference a publication that does not
    // exist yet, and the auto-create is what a first publish depends on.
    expect(steps).toEqual([
      "com.atproto.repo.createRecord:site.standard.publication",
      "com.atproto.repo.createRecord:site.standard.document",
    ]);
    const pub = callOf(
      "com.atproto.repo.createRecord",
      "site.standard.publication",
    );
    const record = pub?.options.input.record as Record<string, unknown>;
    // Named after the handle, editable later — never invented from the form.
    expect(record.name).toBe("writer.example");
    expect(documentRecord().site).toBe(
      `at://${DID}/site.standard.publication/${pub?.options.input.rkey}`,
    );
  });

  it("publishes a loose document rather than refusing when the PDS is unknown", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: "writer.example",
      pds: null,
    });
    const res = await publish();
    // An honest https `site` beats a publish refused over bookkeeping — the
    // words are what the writer pressed the button for.
    expect(documentRecord().site).toBe(
      "https://trygoldroad.com/@writer.example",
    );
    expect(location(res).searchParams.get("published")).toBeTruthy();
    expect(errorFrom(res)).toBeNull();
  });

  it("mints the document URL from the canonical origin, not the hostname it was served on", async () => {
    // The worker also answers on goldroad.kibuchi.workers.dev, and that
    // hostname has gone dark for a day before now. A permanent record must not
    // depend on it.
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: "writer.example",
      pds: null,
    });
    const form = new FormData();
    form.append("title", "The long way round");
    form.append("body", "Some words.");
    await POST({
      request: new Request("https://goldroad.kibuchi.workers.dev/api/publish", {
        method: "POST",
        body: form,
      }),
    });
    expect(documentRecord().site).toBe(
      "https://trygoldroad.com/@writer.example",
    );
  });
});

describe("POST /api/publish — intent=document, the cover image", () => {
  it("uploads the cover BEFORE writing the record that references it", async () => {
    replies.set("com.atproto.repo.uploadBlob", {
      ok: true,
      status: 200,
      data: { blob: blob() },
    });
    await publish({ cover: png() });
    // Only a record reference keeps a blob alive on the PDS: a record written
    // first would name a blob the PDS is free to reclaim.
    expect(steps).toEqual([
      "com.atproto.repo.uploadBlob",
      "com.atproto.repo.createRecord:site.standard.document",
    ]);
    expect(documentRecord().coverImage).toEqual(blob());
  });

  it("refuses a type outside the raster allowlist without uploading anything", async () => {
    for (const type of ["image/svg+xml", "application/pdf"]) {
      posted.length = 0;
      const res = await publish({ cover: png(64, type) });
      expect(posted).toHaveLength(0);
      expect(errorFrom(res)).toBe("cover_type");
    }
  });

  it("refuses a cover over the lexicon's 1MB cap — the client shrink is not trusted", async () => {
    const res = await publish({ cover: png(1_000_001) });
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("cover_too_large");
  });

  it("tells the writer to re-connect when the grant predates the upload scope", async () => {
    for (const status of [401, 403]) {
      posted.length = 0;
      replies.set("com.atproto.repo.uploadBlob", {
        ok: false,
        status,
        data: {},
      });
      const res = await publish({ cover: png() });
      // A scope failure is fixed by signing in again, not by pressing Publish
      // again — so it gets its own code rather than a generic failure.
      expect(errorFrom(res)).toBe("cover_scope");
      expect(callOf("com.atproto.repo.createRecord")).toBeUndefined();
    }
  });

  it("does not publish a post whose cover upload was rejected", async () => {
    replies.set("com.atproto.repo.uploadBlob", {
      ok: false,
      status: 500,
      data: { error: "BlobTooLarge" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await publish({ cover: png() });
    quiet.mockRestore();
    expect(errorFrom(res)).toBe("publish_failed:BlobTooLarge");
    expect(callOf("com.atproto.repo.createRecord")).toBeUndefined();
  });
});

describe("POST /api/publish — intent=document, body images", () => {
  it("references the blobs the body still uses, and only those", async () => {
    const other = "bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await publish({
      body: `Look: ![](/img/${encodeURIComponent(DID)}/${CID})`,
      images: JSON.stringify([blob(), blob({ ref: { $link: other } })]),
    });
    // The PDS serves a blob only while some record references it, and the body
    // is the only honest source of truth for which ones are still in use.
    expect(documentRecord().goldroadInlineImages).toEqual([blob()]);
  });

  it("publishes anyway when the images field is malformed", async () => {
    const res = await publish({ body: "Some words.", images: "{not json" });
    // The words are what matters; a lost image reference is a broken picture,
    // never a lost post.
    expect(location(res).searchParams.get("published")).toBeTruthy();
    expect(documentRecord().goldroadInlineImages).toBeUndefined();
  });
});

describe("POST /api/publish — intent=document, editing a published post", () => {
  const EDIT_RKEY = "3lyk7wxnok2fb";

  beforeEach(() => {
    atproto.getRecordEntry.mockResolvedValue({
      uri: `at://${DID}/site.standard.document/${EDIT_RKEY}`,
      cid: "bafyreiexisting",
      value: {
        $type: "site.standard.document",
        title: "The long way",
        site: PUB_URI,
        path: `/${EDIT_RKEY}`,
        publishedAt: "2026-07-01T09:00:00.000Z",
        textContent: "Older words.",
      },
    });
  });

  const edit = (over: Record<string, string | File> = {}) =>
    publish({ rkey: EDIT_RKEY, ...over });

  it("updates the existing record in place instead of publishing a second one", async () => {
    const res = await edit();
    const put = callOf("com.atproto.repo.putRecord");
    expect(put?.options.input.repo).toBe(DID);
    expect(put?.options.input.collection).toBe("site.standard.document");
    expect(put?.options.input.rkey).toBe(EDIT_RKEY);
    expect(callOf("com.atproto.repo.createRecord")).toBeUndefined();
    // Back to the post itself — an edit's proof is reading it.
    expect(location(res).pathname).toBe(`/@writer.example/${EDIT_RKEY}`);
  });

  /**
   * A writer's repo holds documents written by other atproto apps, and those key
   * theirs by slug rather than by TID. The reader renders them and the posts list
   * offers to edit them — but the write path required a TID, so saving the edit
   * was refused after the writer had already made it. `getRecordEntry` above is
   * what decides the record exists and is ours to touch; the key's SHAPE never
   * was that check.
   */
  it("edits a record this app didn't key, in place", async () => {
    const slug = "my-first-post";
    atproto.getRecordEntry.mockResolvedValue({
      uri: `at://${DID}/site.standard.document/${slug}`,
      cid: "bafyreislug",
      value: {
        $type: "site.standard.document",
        title: "Imported elsewhere",
        site: PUB_URI,
        path: `/${slug}`,
        publishedAt: "2026-07-01T09:00:00.000Z",
        textContent: "Older words.",
      },
    });
    const res = await publish({ rkey: slug });
    expect(callOf("com.atproto.repo.putRecord")?.options.input.rkey).toBe(slug);
    expect(callOf("com.atproto.repo.createRecord")).toBeUndefined();
    expect(location(res).pathname).toBe(`/@writer.example/${slug}`);
  });

  it("pins the version it merged from, so a concurrent write is never clobbered", async () => {
    await edit();
    // Without swapRecord an announce landing in the same second loses its
    // bskyPostRef; the PDS answers InvalidSwap instead and the writer retries.
    expect(callOf("com.atproto.repo.putRecord")?.options.input.swapRecord).toBe(
      "bafyreiexisting",
    );
  });

  it("keeps the original publish date while recording the edit", async () => {
    await edit();
    const record = callOf("com.atproto.repo.putRecord")?.options.input
      .record as Record<string, unknown>;
    expect(record.publishedAt).toBe("2026-07-01T09:00:00.000Z");
    expect(typeof record.updatedAt).toBe("string");
    expect(record.textContent).toBe("Some words.");
  });

  it("refuses to edit a document whose content another app owns", async () => {
    atproto.getRecordEntry.mockResolvedValue({
      uri: `at://${DID}/site.standard.document/${EDIT_RKEY}`,
      cid: "bafyreileaflet",
      value: {
        $type: "site.standard.document",
        title: "Written elsewhere",
        site: PUB_URI,
        path: `/${EDIT_RKEY}`,
        content: { $type: "pub.leaflet.content", blocks: [] },
      },
    });
    const res = await edit();
    // Updating the plaintext while readers keep rendering the rich content is
    // silent corruption of somebody's post.
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("not_editable");
  });

  it("says not_found rather than creating a post when the record can't be read", async () => {
    atproto.getRecordEntry.mockRejectedValue(new Error("404"));
    const res = await edit();
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("not_found");
  });

  it("says not_found rather than creating a post when the PDS is unknown", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: "writer.example",
      pds: null,
    });
    const res = await edit();
    // A create here would leave the writer with the same post published twice.
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("not_found");
  });

  it("adopts a mirrored post as the original only once the edit has landed", async () => {
    await edit({ adoptOriginal: "1" });
    // The checkbox stops the mirror treatment (noindex + provenance line). An
    // adoption recorded against an edit that failed would drop that treatment
    // from a post still showing the old text.
    expect(ledger.adoptMirror).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      EDIT_RKEY,
    );
  });

  it("does not adopt when the edit itself was rejected", async () => {
    replies.set("com.atproto.repo.putRecord", {
      ok: false,
      status: 400,
      data: { error: "InvalidSwap" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await edit({ adoptOriginal: "1" });
    quiet.mockRestore();
    expect(ledger.adoptMirror).not.toHaveBeenCalled();
  });

  it("leaves the mirror treatment in place when the box is unchecked", async () => {
    await edit();
    expect(ledger.adoptMirror).not.toHaveBeenCalled();
  });

  it("still reports the edit when the adoption flakes", async () => {
    ledger.adoptMirror.mockRejectedValue(new Error("d1 down"));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await edit({ adoptOriginal: "1" });
    quiet.mockRestore();
    // The edit is live; saving again is the retry, and it costs nothing.
    expect(location(res).pathname).toBe(`/@writer.example/${EDIT_RKEY}`);
  });

  it("keeps the writer on the post they were editing when the save fails", async () => {
    replies.set("com.atproto.repo.putRecord", {
      ok: false,
      status: 400,
      data: { error: "InvalidSwap" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await edit();
    quiet.mockRestore();
    const url = location(res);
    // A bare /write?error strands them on a blank page with their words gone.
    expect(url.pathname).toBe("/write");
    expect(url.searchParams.get("edit")).toBe(EDIT_RKEY);
    expect(url.searchParams.get("error")).toBe("publish_failed:InvalidSwap");
  });
});

describe("POST /api/publish — intent=document, the draft the post came from", () => {
  const fields = { draftId: DRAFT_ID };

  it("removes the draft only AFTER the record has landed", async () => {
    await publish(fields);
    // A draft row is the only copy of the writer's words until the record is
    // live; deleting it first would lose a post to any PDS hiccup.
    expect(
      steps.indexOf("com.atproto.repo.createRecord:site.standard.document"),
    ).toBeLessThan(steps.indexOf("deleteDraft"));
    expect(drafts.deleteDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
  });

  it("LEAVES THE DRAFT ALONE when the publish failed", async () => {
    replies.set("com.atproto.repo.createRecord", {
      ok: false,
      status: 502,
      data: { error: "UpstreamFailure" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await publish(fields);
    quiet.mockRestore();
    // The words are the writer's, and a failed write is no evidence to delete
    // them on. This is also their only way back into the editor.
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
    expect(schedules.deleteSchedulesForDraft).not.toHaveBeenCalled();
    expect(errorFrom(res)).toBe("publish_failed:UpstreamFailure");
    expect(location(res).searchParams.get("published")).toBeNull();
  });

  it("clears the schedule with the draft, so no tick fails a live post", async () => {
    await publish(fields);
    expect(schedules.deleteSchedulesForDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
    );
  });

  it("still reports the publish when the cleanup flakes", async () => {
    drafts.deleteDraft.mockRejectedValue(new Error("d1 down"));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await publish(fields);
    quiet.mockRestore();
    // The post is already live — a leftover row costs one manual tidy, and
    // reporting a failure here would have the writer publish it twice.
    expect(location(res).searchParams.get("published")).toBeTruthy();
    expect(errorFrom(res)).toBeNull();
  });

  it("ignores a draft id that isn't one, without touching the store", async () => {
    await publish({ draftId: "../../etc/passwd" });
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
    expect(ledger.selectImportItemByDraft).not.toHaveBeenCalled();
  });
});

describe("POST /api/publish — intent=document, a post that arrived by import", () => {
  const ORIGINAL = new Date("2024-03-11T08:30:00.000Z");
  const fields = { draftId: DRAFT_ID };

  beforeEach(() => {
    ledger.selectImportItemByDraft.mockResolvedValue([
      { id: "row-1", did: DID, draftId: DRAFT_ID, originalAt: ORIGINAL },
    ]);
  });

  it("publishes with the date it was actually written", async () => {
    await publish(fields);
    expect(documentRecord().publishedAt).toBe(ORIGINAL.toISOString());
  });

  it("backdates the record KEY too, so the archive orders by when it was written", async () => {
    await publish(fields);
    const rkey = String(
      callOf("com.atproto.repo.createRecord", "site.standard.document")?.options
        .input.rkey,
    );
    // TIDs are sortable and the repo listing is ordered by them, so a
    // now-minted key would put a 2024 piece at the top of the archive.
    expect(rkey < generateTid()).toBe(true);
    expect(documentRecord().path).toBe(`/${rkey}`);
  });

  it("records the key it published under, so a re-import sees a duplicate", async () => {
    await publish(fields);
    const rkey = callOf(
      "com.atproto.repo.createRecord",
      "site.standard.document",
    )?.options.input.rkey;
    expect(ledger.setPublishedRkey).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT_ID,
      rkey,
    );
  });

  it("does not claim a publish in the ledger when the record never landed", async () => {
    replies.set("com.atproto.repo.createRecord", {
      ok: false,
      status: 502,
      data: { error: "UpstreamFailure" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await publish(fields);
    quiet.mockRestore();
    // A ledger row pointing at a post that does not exist would have the feed
    // refuse the item forever.
    expect(ledger.setPublishedRkey).not.toHaveBeenCalled();
  });

  it("publishes as a normal now-dated post when the ledger read flakes", async () => {
    ledger.selectImportItemByDraft.mockRejectedValue(new Error("d1 down"));
    const res = await publish(fields);
    // Losing the original date is a cosmetic loss; refusing the publish is not.
    expect(location(res).searchParams.get("published")).toBeTruthy();
    expect(String(documentRecord().publishedAt)).not.toBe(
      ORIGINAL.toISOString(),
    );
  });

  it("ignores an original date in the future rather than publishing ahead of now", async () => {
    ledger.selectImportItemByDraft.mockResolvedValue([
      {
        id: "row-1",
        did: DID,
        draftId: DRAFT_ID,
        originalAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    ]);
    await publish(fields);
    // A record dated in the future sorts above everything the writer ever
    // publishes afterwards.
    expect(
      new Date(String(documentRecord().publishedAt)).getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });
});

describe("POST /api/publish — intent=document, refusals write nothing", () => {
  it("refuses an untitled post — the one thing publishing cannot do without", async () => {
    const res = await publish({ title: "   " });
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("missing_title");
  });

  it("keeps the edit loaded when an untitled save comes from an edit", async () => {
    const res = await publish({ title: "", rkey: "3lyk7wxnok2fb" });
    expect(location(res).searchParams.get("edit")).toBe("3lyk7wxnok2fb");
    expect(errorFrom(res)).toBe("missing_title");
  });

  it("refuses a title or body past the record's limits", async () => {
    expect(
      errorFrom(await publish({ title: "t".repeat(MAX_TITLE_LENGTH + 1) })),
    ).toBe("too_long");
    expect(
      errorFrom(await publish({ body: "b".repeat(MAX_BODY_LENGTH + 1) })),
    ).toBe("too_long");
    expect(posted).toHaveLength(0);
  });

  it("refuses a post that fits the character cap but not the record's byte cap", async () => {
    // Half the character budget, and nowhere near the byte one: the body is
    // stored twice, so this serializes to ~160 KB against a 140 KB ceiling.
    // Before the guard existed the record went to the PDS and came back 413 as
    // an unexplained `publish_failed`.
    const res = await publish({
      body: "x".repeat(80_000),
      draftId: DRAFT_ID,
    });
    expect(errorFrom(res)).toBe("too_large");
    expect(
      posted.some(
        (p) =>
          p.nsid === "com.atproto.repo.createRecord" &&
          p.options.input.collection === "site.standard.document",
      ),
    ).toBe(false);
    // The words are still in the draft, and the redirect says where.
    expect(location(res).searchParams.get("draft")).toBe(DRAFT_ID);
  });

  it("refuses a non-Latin post far short of the character cap", async () => {
    // 25,000 characters — a short essay — at three bytes each, twice over.
    const res = await publish({ body: "字".repeat(25_000) });
    expect(errorFrom(res)).toBe("too_large");
    expect(posted).toHaveLength(0);
  });

  it("refuses an EDIT that crosses the byte cap, without writing the record", async () => {
    const rkey = "3lyk7wxnok2fb";
    atproto.getRecordEntry.mockResolvedValue({
      uri: `at://${DID}/site.standard.document/${rkey}`,
      cid: "bafyreiexisting",
      value: {
        $type: "site.standard.document",
        title: "Old",
        site: PUB_URI,
        path: `/${rkey}`,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await publish({ rkey, body: "x".repeat(80_000) });
    expect(errorFrom(res)).toBe("too_large");
    expect(location(res).searchParams.get("edit")).toBe(rkey);
    expect(callOf("com.atproto.repo.putRecord")).toBeUndefined();
  });

  it("refuses a cross-site post before reading the session", async () => {
    const res = await publish({}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(posted).toHaveLength(0);
    // The gate runs first, so a cross-site POST costs no session read at all.
    expect(atproto.resolveDidIdentity).not.toHaveBeenCalled();
  });

  it("refuses a signed-out publish", async () => {
    session.did = null;
    const res = await publish();
    // The security property is that nothing was written. The SHAPE is a 303
    // rather than a bare 401 because this is a full-page form POST: replying
    // text/plain navigated the writer off the editor and took the composed
    // post with it.
    expect(posted).toHaveLength(0);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/write?error=session_expired");
  });

  it("sends a dead session to sign-in and clears the cookies behind it", async () => {
    restoreFails.current = true;
    const res = await publish();
    // A redirect, not JSON: this intent is a form post, and sign-in for it
    // lives on /write. Stale cookies left in place would loop the writer.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/write?error=session_expired");
    expect(res.headers.get("set-cookie")).toBeTruthy();
    expect(posted).toHaveLength(0);
  });
});

/**
 * Every refusal above already leaves the words intact in D1. That is not the
 * same as the writer getting them back: a refusal that redirects to bare
 * `/write` opens an EMPTY editor, and the writer — who has no way to know a
 * draft row survived — reasonably concludes the post is gone. "Saved, and no
 * comfort at all."
 *
 * So the redirect has to name where the words are. An edit resumes by rkey (a
 * published record); a new composition resumes by draft id.
 */
describe("POST /api/publish — intent=document, a refusal hands the words back", () => {
  const draftOf = (res: Response) => location(res).searchParams.get("draft");

  it("returns a new composition to its draft, not to a blank editor", async () => {
    const res = await publish({ title: "  ", draftId: DRAFT_ID });
    expect(errorFrom(res)).toBe("missing_title");
    expect(draftOf(res)).toBe(DRAFT_ID);
  });

  it("returns the draft when the post is over the record's limits", async () => {
    const res = await publish({
      body: "b".repeat(MAX_BODY_LENGTH + 1),
      draftId: DRAFT_ID,
    });
    expect(errorFrom(res)).toBe("too_long");
    expect(draftOf(res)).toBe(DRAFT_ID);
  });

  it("returns the draft when the cover is refused", async () => {
    const svg = new File([new Uint8Array(8)], "cover.svg", {
      type: "image/svg+xml",
    });
    const res = await publish({ draftId: DRAFT_ID, cover: svg });
    expect(errorFrom(res)).toBe("cover_type");
    expect(draftOf(res)).toBe(DRAFT_ID);
  });

  it("returns the draft when the cover upload itself fails", async () => {
    replies.set("com.atproto.repo.uploadBlob", {
      ok: false,
      status: 502,
      data: { error: "UpstreamFailure" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await publish({ draftId: DRAFT_ID, cover: png() });
    quiet.mockRestore();
    expect(errorFrom(res)).toBe("publish_failed:UpstreamFailure");
    expect(draftOf(res)).toBe(DRAFT_ID);
  });

  // The worst of the set before this change: the record write is the failure a
  // writer is most likely to actually hit, it happens after they have watched
  // the button spin, and it dropped every parameter it had.
  it("returns the draft when the record write fails", async () => {
    replies.set("com.atproto.repo.createRecord", {
      ok: false,
      status: 502,
      data: { error: "UpstreamFailure" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await publish({ draftId: DRAFT_ID });
    quiet.mockRestore();
    expect(errorFrom(res)).toBe("publish_failed:UpstreamFailure");
    expect(draftOf(res)).toBe(DRAFT_ID);
    // And the row it points at is still there to be resumed.
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
  });

  it("prefers the edit when a rejected publish carries both", async () => {
    // An edit's words live in the published record, which the editor reloads
    // by rkey. Sending it to ?draft= as well would offer two sources of truth
    // for one post and let the stale one win.
    const res = await publish({
      title: "",
      rkey: "3lyk7wxnok2fb",
      draftId: DRAFT_ID,
    });
    expect(location(res).searchParams.get("edit")).toBe("3lyk7wxnok2fb");
    expect(draftOf(res)).toBeNull();
  });

  it("adds no draft parameter when there is no draft to point at", async () => {
    // A post composed and published faster than the first autosave has no row.
    // The blank editor is then the honest answer — inventing a ?draft= for a
    // row that does not exist would send the writer to a "that draft is gone"
    // page, which is worse than the truth.
    const res = await publish({ title: "  " });
    expect(errorFrom(res)).toBe("missing_title");
    expect(draftOf(res)).toBeNull();
  });

  it("ignores a draft id that is not one", async () => {
    const res = await publish({ title: "  ", draftId: "../../etc/passwd" });
    expect(draftOf(res)).toBeNull();
    // And nothing of it reaches the header it was refused from.
    expect(res.headers.get("location") ?? "").not.toContain("passwd");
  });

  it("falls back to the draft when the edit key is malformed", async () => {
    // /write drops an `?edit=` it cannot parse, so treating any non-empty rkey
    // as an edit target spends the redirect on a key that will be thrown away
    // — landing the writer on the blank editor while a usable draft id was
    // sitting in the same request.
    const res = await publish({
      title: "  ",
      rkey: "../../etc/passwd",
      draftId: DRAFT_ID,
    });
    expect(location(res).searchParams.get("edit")).toBeNull();
    expect(draftOf(res)).toBe(DRAFT_ID);
    expect(res.headers.get("location") ?? "").not.toContain("passwd");
  });

  it("keeps a record key this app didn't mint", async () => {
    // A document written by another atproto app is keyed by slug, and both the
    // reader and the posts list already treat those as editable. Held to the TID
    // shape, a refusal here dropped the key and handed the writer a blank NEW
    // post instead of the one they were editing.
    const res = await publish({
      title: "  ",
      rkey: "my-first-post",
      draftId: DRAFT_ID,
    });
    expect(location(res).searchParams.get("edit")).toBe("my-first-post");
    expect(draftOf(res)).toBeNull();
  });
});
