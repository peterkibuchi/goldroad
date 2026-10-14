// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The record-writing core all three publish paths share — the interactive
 * publish, "publish now", and the cron.
 *
 * The reason it exists is drift: three copies of "which publication does a
 * document attach to, and what is written back afterwards" would diverge, and
 * the copy that diverged would be the cron's, because nobody watches it. So
 * this suite pins the policy once, and both callers inherit it.
 */
const atproto = vi.hoisted(() => ({ listRecords: vi.fn() }));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

const drafts = vi.hoisted(() => ({ deleteDraft: vi.fn() }));
vi.mock("~/lib/drafts", () => drafts);

const ledger = vi.hoisted(() => ({ setPublishedRkey: vi.fn() }));
vi.mock("~/lib/import-store", () => ledger);

const searchIndex = vi.hoisted(() => ({ indexDocument: vi.fn() }));
vi.mock("~/lib/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/search")>()),
  ...searchIndex,
}));

const schedules = vi.hoisted(() => ({ deleteSchedulesForDraft: vi.fn() }));
vi.mock("~/lib/scheduled-posts", () => schedules);

const hosted = vi.hoisted(() => ({ recordHostedPublication: vi.fn() }));
vi.mock("~/lib/hosted-publications", () => hosted);

import {
  findOwnPublication,
  publishStoredDraft,
  resolvePublicationSite,
} from "../lib/publish-document";

const DID = "did:plc:fake2222222222writer2222" as const;
const PUB_URI = `at://${DID}/site.standard.publication/3lyk73wxnok2f`;
/** Never queried: the D1 calls this module makes are mocked above. */
const DB = {} as Parameters<typeof resolvePublicationSite>[0]["db"];

type Posted = { nsid: string; input: Record<string, unknown> };

/** A stand-in for @atcute/client: records what was posted, answers as told. */
function fakeRpc(
  answers: Array<{ ok: boolean; status?: number; data?: unknown }> = [],
  /** What a getRecord finds at the key: the retry check. */
  existing: "missing" | "unknown" | Record<string, unknown> = "missing",
) {
  const posted: Posted[] = [];
  const got: Array<Record<string, unknown>> = [];
  const rpc = {
    get(_nsid: string, options: { params: Record<string, unknown> }) {
      got.push(options.params);
      if (typeof existing === "object")
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { value: existing, cid: "bafyreiearlier" },
        });
      return Promise.resolve({
        ok: false,
        status: existing === "missing" ? 400 : 502,
        data: {
          error: existing === "missing" ? "RecordNotFound" : "UpstreamFailure",
        },
      });
    },
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, input: options.input });
      const answer = answers.shift() ?? { ok: true, data: {} };
      return Promise.resolve({
        ok: answer.ok,
        status: answer.status ?? (answer.ok ? 200 : 400),
        data: answer.data ?? {},
      });
    },
    // biome-ignore lint/suspicious/noExplicitAny: a narrow stand-in for the client
  } as any;
  return { rpc, posted, got };
}

const DRAFT = {
  id: "11111111-2222-4333-8444-555555555555",
  title: "The long way round",
  dek: "On slow software",
  markdown: "Some words.",
  inlineImages: "",
};

function input(
  rpc: unknown,
  extra: Partial<Parameters<typeof publishStoredDraft>[0]> = {},
) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: no live D1 in this suite
    rpc: rpc as any,
    // biome-ignore lint/suspicious/noExplicitAny: the store calls are mocked
    db: {} as any,
    did: DID,
    ident: "writer.example",
    pds: "https://pds.example.com",
    origin: "https://trygoldroad.com",
    origins: ["https://trygoldroad.com"] as const,
    draft: DRAFT,
    ...extra,
  };
}

beforeEach(() => {
  atproto.listRecords.mockReset();
  searchIndex.indexDocument.mockReset();
  searchIndex.indexDocument.mockResolvedValue(undefined);
  drafts.deleteDraft.mockReset();
  ledger.setPublishedRkey.mockReset();
  atproto.listRecords.mockResolvedValue([
    {
      uri: PUB_URI,
      cid: "bafyreipublication",
      value: {
        $type: "site.standard.publication",
        name: "The Long Way",
        url: "https://trygoldroad.com/@writer.example",
      },
    },
  ]);
  drafts.deleteDraft.mockResolvedValue([{ id: DRAFT.id }]);
  ledger.setPublishedRkey.mockResolvedValue([]);
  schedules.deleteSchedulesForDraft.mockReset();
  schedules.deleteSchedulesForDraft.mockResolvedValue([]);
  hosted.recordHostedPublication.mockReset();
  hosted.recordHostedPublication.mockReturnValue(Promise.resolve());
});

describe("resolvePublicationSite", () => {
  it("attaches to the writer's own publication when they have one", async () => {
    const { rpc, posted } = fakeRpc();
    const site = await resolvePublicationSite({
      rpc,
      db: DB,
      did: DID,
      ident: "writer.example",
      pds: "https://pds.example.com",
      origin: "https://trygoldroad.com",
      origins: ["https://trygoldroad.com"],
    });
    expect(site).toBe(PUB_URI);
    expect(posted).toHaveLength(0); // nothing created
  });

  it("creates one on a first publish, named after the handle", async () => {
    atproto.listRecords.mockResolvedValue([]);
    const { rpc, posted } = fakeRpc();
    const site = await resolvePublicationSite({
      rpc,
      db: DB,
      did: DID,
      ident: "writer.example",
      pds: "https://pds.example.com",
      origin: "https://trygoldroad.com",
      origins: ["https://trygoldroad.com"],
    });
    expect(posted[0]?.nsid).toBe("com.atproto.repo.createRecord");
    expect(posted[0]?.input.collection).toBe("site.standard.publication");
    expect(site).toMatch(/^at:\/\/did:plc:.*\/site\.standard\.publication\//);
  });

  it("never adopts a publication another app owns", async () => {
    atproto.listRecords.mockResolvedValue([
      {
        uri: `at://${DID}/site.standard.publication/3aaaaaaaaaaaa`,
        value: {
          $type: "site.standard.publication",
          url: "https://elsewhere.leaflet.pub",
        },
      },
    ]);
    const { rpc } = fakeRpc();
    const site = await resolvePublicationSite({
      rpc,
      db: DB,
      did: DID,
      ident: "writer.example",
      pds: "https://pds.example.com",
      origin: "https://trygoldroad.com",
      origins: ["https://trygoldroad.com"],
    });
    // It created its own instead of writing into Leaflet's.
    expect(site).not.toContain("3aaaaaaaaaaaa");
  });

  it("falls back to the https publication URL with no PDS to ask", async () => {
    const { rpc, posted } = fakeRpc();
    const site = await resolvePublicationSite({
      rpc,
      db: DB,
      did: DID,
      ident: "writer.example",
      pds: null,
      origin: "https://trygoldroad.com",
      origins: ["https://trygoldroad.com"],
    });
    expect(site).toBe("https://trygoldroad.com/@writer.example");
    expect(posted).toHaveLength(0);
  });

  // The distinction the whole discriminated return exists for. A PDS that
  // didn't answer is not a writer without a publication, and creating one on
  // that guess leaves a second, permanent, public record in their repo — one
  // that every later lookup ignores, because `reverse: true` is oldest-first.
  it("does not create a publication when the read failed", async () => {
    atproto.listRecords.mockRejectedValue(new Error("502 Bad Gateway"));
    const { rpc, posted } = fakeRpc();
    const site = await resolvePublicationSite({
      rpc,
      db: DB,
      did: DID,
      ident: "writer.example",
      pds: "https://pds.example.com",
      origin: "https://trygoldroad.com",
      origins: ["https://trygoldroad.com"],
    });
    expect(posted).toHaveLength(0);
    // A loose document — the same honest fallback as having no PDS to ask.
    expect(site).toBe("https://trygoldroad.com/@writer.example");
  });
});

describe("resolvePublicationSite — the sitemap's list of hosted publications", () => {
  const resolve = (pds: string | null = "https://pds.example.com") =>
    resolvePublicationSite({
      rpc: fakeRpc().rpc,
      db: DB,
      did: DID,
      ident: "writer.example",
      pds,
      origin: "https://trygoldroad.com",
      origins: ["https://trygoldroad.com"],
    });

  it("notes the writer's own publication at its recorded url", async () => {
    await resolve();
    expect(hosted.recordHostedPublication).toHaveBeenCalledWith(
      DB,
      DID,
      "https://trygoldroad.com/@writer.example",
    );
  });

  it("notes a publication created on a first publish", async () => {
    atproto.listRecords.mockResolvedValue([]);
    await resolve();
    expect(hosted.recordHostedPublication).toHaveBeenCalledWith(
      DB,
      DID,
      "https://trygoldroad.com/@writer.example",
    );
  });

  it("notes nothing when no publication record of ours exists", async () => {
    await resolve(null);
    atproto.listRecords.mockRejectedValue(new Error("502 Bad Gateway"));
    await resolve();
    expect(hosted.recordHostedPublication).not.toHaveBeenCalled();
  });

  it("publishes anyway when the note fails", async () => {
    hosted.recordHostedPublication.mockReturnValue(
      Promise.reject(new Error("D1 unavailable")),
    );
    await expect(resolve()).resolves.toBe(PUB_URI);
  });
});

describe("findOwnPublication", () => {
  it("reports a failed read as unreadable, not as absent", async () => {
    atproto.listRecords.mockRejectedValue(new Error("502 Bad Gateway"));
    const found = await findOwnPublication("https://pds.example.com", DID, [
      "https://trygoldroad.com",
    ]);
    expect(found.ok).toBe(false);
    expect(found.own).toBeNull();
  });

  it("reports an empty repo as readable with nothing in it", async () => {
    atproto.listRecords.mockResolvedValue([]);
    const found = await findOwnPublication("https://pds.example.com", DID, [
      "https://trygoldroad.com",
    ]);
    expect(found.ok).toBe(true);
    expect(found.own).toBeNull();
  });

  it("reports another app's publication as readable but not ours", async () => {
    atproto.listRecords.mockResolvedValue([
      {
        uri: `at://${DID}/site.standard.publication/3aaaaaaaaaaaa`,
        value: {
          $type: "site.standard.publication",
          url: "https://elsewhere.leaflet.pub",
        },
      },
    ]);
    const found = await findOwnPublication("https://pds.example.com", DID, [
      "https://trygoldroad.com",
    ]);
    expect(found.ok).toBe(true);
    expect(found.own).toBeNull();
  });
});

describe("publishStoredDraft", () => {
  it("writes the draft's own words to a site.standard.document", async () => {
    const { rpc, posted } = fakeRpc();
    const result = await publishStoredDraft(input(rpc));
    expect(result.ok).toBe(true);
    const create = posted.find(
      (p) => p.input.collection === "site.standard.document",
    );
    expect(create?.input.repo).toBe(DID);
    const record = create?.input.record as Record<string, unknown>;
    expect(record.title).toBe(DRAFT.title);
    expect(record.textContent).toBe("Some words.");
    expect(record.description).toBe("On slow software");
    expect(record.site).toBe(PUB_URI);
    // No cover: a blob uploaded now and referenced hours later is a blob the
    // PDS may have reclaimed, so scheduled posts publish text.
    expect(record.coverImage).toBeUndefined();
  });

  it("reports the rkey it published under, and it matches the record path", async () => {
    const { rpc, posted } = fakeRpc();
    const result = await publishStoredDraft(input(rpc));
    if (!result.ok) throw new Error("expected a publish");
    const create = posted.find(
      (p) => p.input.collection === "site.standard.document",
    );
    expect(create?.input.rkey).toBe(result.rkey);
    const record = create?.input.record as { path?: string } | undefined;
    expect(record?.path).toBe(`/${result.rkey}`);
  });

  it("completes the draft and records the import write-back", async () => {
    const { rpc } = fakeRpc();
    await publishStoredDraft(input(rpc));
    expect(ledger.setPublishedRkey).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT.id,
      expect.any(String),
    );
    expect(drafts.deleteDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT.id,
    );
  });

  it("puts a scheduled post into search under the key it published at", async () => {
    const { rpc } = fakeRpc();
    const result = await publishStoredDraft(input(rpc));
    if (!result.ok) throw new Error("expected a publish");
    expect(searchIndex.indexDocument).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      result.rkey,
      expect.objectContaining({ textContent: "Some words." }),
    );
  });

  it("clears the schedule too, so no tick reports a failure for a live post", async () => {
    // A row that outlives its own published post is not harmless: the next tick
    // finds the draft gone and writes "the draft no longer exists" onto a post
    // the writer can already read.
    const { rpc } = fakeRpc();
    await publishStoredDraft(input(rpc));
    expect(schedules.deleteSchedulesForDraft).toHaveBeenCalledWith(
      expect.anything(),
      DID,
      DRAFT.id,
    );
  });

  it("still reports success when the write-backs flake — the record is live", async () => {
    ledger.setPublishedRkey.mockRejectedValue(new Error("d1 down"));
    drafts.deleteDraft.mockRejectedValue(new Error("d1 down"));
    schedules.deleteSchedulesForDraft.mockRejectedValue(new Error("d1 down"));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rpc } = fakeRpc();
    expect((await publishStoredDraft(input(rpc))).ok).toBe(true);
    quiet.mockRestore();
  });

  it("carries the body's image blobs, so a published post's pictures work", async () => {
    // A PDS only serves a blob some record references. The browser's
    // per-session store of these is long gone by the time a cron runs, which is
    // why they travel with the draft.
    const cid = "bafkreiinlineimage2222222222222222222222222222222222222222";
    const blob = {
      $type: "blob",
      ref: { $link: cid },
      mimeType: "image/jpeg",
      size: 1234,
    };
    const { rpc, posted } = fakeRpc();
    await publishStoredDraft(
      input(rpc, {
        draft: {
          ...DRAFT,
          markdown: `Words.\n\n![a photo](/img/${DID}/${cid})`,
          inlineImages: JSON.stringify([blob]),
        },
      }),
    );
    const record = posted.find(
      (p) => p.input.collection === "site.standard.document",
    )?.input.record as { goldroadInlineImages?: unknown[] };
    expect(record.goldroadInlineImages).toEqual([blob]);
  });

  it("keeps only the blobs the body still references", async () => {
    const stale = {
      $type: "blob",
      ref: {
        $link: "bafkreideleted222222222222222222222222222222222222222222",
      },
      mimeType: "image/jpeg",
      size: 10,
    };
    const { rpc, posted } = fakeRpc();
    await publishStoredDraft(
      input(rpc, {
        draft: { ...DRAFT, inlineImages: JSON.stringify([stale]) },
      }),
    );
    const record = posted.find(
      (p) => p.input.collection === "site.standard.document",
    )?.input.record as { goldroadInlineImages?: unknown[] };
    expect(record.goldroadInlineImages).toBeUndefined();
  });

  it("publishes the words even when the stored references are unreadable", async () => {
    // An image that loses its reference is a broken picture; a post that
    // refuses to publish over one is a lost post.
    const { rpc } = fakeRpc();
    const result = await publishStoredDraft(
      input(rpc, { draft: { ...DRAFT, inlineImages: "{not json" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an untitled draft with a reason a writer can act on", async () => {
    const { rpc, posted } = fakeRpc();
    const result = await publishStoredDraft(
      input(rpc, { draft: { ...DRAFT, title: "  " } }),
    );
    expect(result).toMatchObject({ ok: false, retry: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toMatch(/no title/i);
    expect(posted).toHaveLength(0);
  });

  it("refuses a draft that fits the character cap but not the record's byte cap", async () => {
    // Nobody is watching at 09:00, so this is measured here or not at all —
    // otherwise the PDS answers 413 and the writer wakes to a post that
    // silently never went out.
    const { rpc, posted } = fakeRpc();
    const result = await publishStoredDraft(
      input(rpc, { draft: { ...DRAFT, markdown: "x".repeat(80_000) } }),
    );
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("too_large");
    // Final, not retried: it will be exactly this large next hour.
    expect(result.retry).toBe(false);
    // The sentence stored on the row and shown in the posts manager names the
    // limit and what to do about it.
    expect(result.reason).toMatch(/140,000 bytes/);
    expect(result.reason).toMatch(/split it into two posts/i);
    expect(
      posted.filter((p) => p.nsid === "com.atproto.repo.createRecord"),
    ).toHaveLength(0);
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
  });

  it("treats a 5xx as worth another hour", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rpc } = fakeRpc([
      { ok: false, status: 502, data: { error: "UpstreamFailure" } },
    ]);
    const result = await publishStoredDraft(input(rpc, { pds: null }));
    if (result.ok) throw new Error("expected a failure");
    expect(result.retry).toBe(true);
    expect(result.reason).toMatch(/try again within the hour/i);
    expect(result.code).toBe("publish_failed:UpstreamFailure");
    quiet.mockRestore();
  });

  it("treats a refusal as final — next hour will refuse it too", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rpc } = fakeRpc([
      { ok: false, status: 400, data: { error: "InvalidRequest" } },
    ]);
    const result = await publishStoredDraft(input(rpc, { pds: null }));
    if (result.ok) throw new Error("expected a failure");
    expect(result.retry).toBe(false);
    expect(result.reason).toMatch(/refused/i);
    quiet.mockRestore();
  });

  it("names a missing image, and doesn't retry what can't come back", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rpc } = fakeRpc([
      { ok: false, status: 400, data: { error: "BlobNotFound" } },
    ]);
    const result = await publishStoredDraft(input(rpc, { pds: null }));
    if (result.ok) throw new Error("expected a failure");
    expect(result.retry).toBe(false);
    expect(result.code).toBe("image_missing");
    expect(result.reason).toMatch(/images is no longer in your repo/);
    quiet.mockRestore();
  });

  it("does not delete the draft when the publish failed", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rpc } = fakeRpc([
      { ok: false, status: 400, data: { error: "InvalidRequest" } },
    ]);
    await publishStoredDraft(input(rpc, { pds: null }));
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
    quiet.mockRestore();
  });
});

describe("publishStoredDraft past an image the repo no longer holds", () => {
  const CID_A = "bafkreigoneaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const CID_B = "bafkreikeptbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ref = (cid: string) => ({
    $type: "blob",
    ref: { $link: cid },
    mimeType: "image/jpeg",
    size: 1234,
  });
  const draft = {
    ...DRAFT,
    markdown: `Words.\n\n![gone](/img/${DID}/${CID_A})\n\n![kept](/img/${DID}/${CID_B})`,
    inlineImages: JSON.stringify([ref(CID_A), ref(CID_B)]),
  };
  const missing = (cid: string) => ({
    ok: false,
    status: 400,
    data: { error: "BlobNotFound", message: `Could not find blob: ${cid}` },
  });
  const documents = (posted: Posted[]) =>
    posted
      .filter((p) => p.input.collection === "site.standard.document")
      .map(
        (p) =>
          p.input.record as {
            textContent?: string;
            goldroadInlineImages?: unknown[];
          },
      );

  it("goes out without the missing image and keeps the rest", async () => {
    const { rpc, posted } = fakeRpc([missing(CID_A)]);
    const result = await publishStoredDraft(
      input(rpc, { pds: null, draft, missingImageBudget: 14 }),
    );
    if (!result.ok) throw new Error("expected a publish");
    expect(result.imagesDropped).toBe(1);
    const [, second] = documents(posted);
    expect(second.goldroadInlineImages).toEqual([ref(CID_B)]);
    expect(second.textContent).toContain("kept");
    expect(second.textContent).not.toContain("gone");
  });

  it("spends no more writes than its budget, then refuses", async () => {
    const { rpc, posted } = fakeRpc([missing(CID_A), missing(CID_B)]);
    const result = await publishStoredDraft(
      input(rpc, { pds: null, draft, missingImageBudget: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("image_missing");
    expect(documents(posted)).toHaveLength(2);
  });

  it("counts a reserved key's write as three", async () => {
    const { rpc, posted } = fakeRpc([missing(CID_A)]);
    const result = await publishStoredDraft(
      input(rpc, {
        pds: null,
        draft,
        rkey: "3lyk73wxnokrs",
        missingImageBudget: 2,
      }),
    );
    expect(result.ok).toBe(false);
    expect(documents(posted)).toHaveLength(1);
  });

  it("refuses without retrying when the server names no image the body uses", async () => {
    const { rpc, posted } = fakeRpc([
      { ok: false, status: 400, data: { error: "BlobNotFound" } },
    ]);
    const result = await publishStoredDraft(
      input(rpc, { pds: null, draft, missingImageBudget: 14 }),
    );
    expect(result.ok).toBe(false);
    expect(documents(posted)).toHaveLength(1);
  });
});

describe("publishStoredDraft with a reserved key (the cron's retries)", () => {
  const RESERVED = "3lyk73wxnokrs";
  const refused = () => [
    { ok: false, status: 500, data: { error: "InternalServerError" } },
  ];
  const documentWrites = (posted: Posted[]) =>
    posted.filter((p) => p.input.collection === "site.standard.document");

  it("publishes under the reserved key", async () => {
    const { rpc, posted } = fakeRpc();
    const result = await publishStoredDraft(input(rpc, { rkey: RESERVED }));
    expect(result).toEqual({ ok: true, rkey: RESERVED, imagesDropped: 0 });
    expect(documentWrites(posted)[0].input.rkey).toBe(RESERVED);
  });

  it("replaces what an earlier attempt wrote there with the current draft", async () => {
    // That attempt landed but never reported back, and the writer has edited
    // the draft since. A second record would duplicate the post; counting the
    // old one as done would drop the edits.
    const earlier = {
      $type: "site.standard.document",
      title: "The long way rond",
      bskyPostRef: { uri: "at://x/app.bsky.feed.post/1", cid: "bafypost" },
    };
    const { rpc, posted, got } = fakeRpc(refused(), earlier);
    const result = await publishStoredDraft(input(rpc, { rkey: RESERVED }));
    expect(result).toEqual({ ok: true, rkey: RESERVED, imagesDropped: 0 });
    expect(got).toEqual([
      { repo: DID, collection: "site.standard.document", rkey: RESERVED },
    ]);
    const [, put] = documentWrites(posted);
    expect(put.input).toMatchObject({
      rkey: RESERVED,
      swapRecord: "bafyreiearlier",
      record: {
        title: "The long way round",
        // An announce made in between survives the replace.
        bskyPostRef: earlier.bskyPostRef,
      },
    });
    expect(drafts.deleteDraft).toHaveBeenCalled();
  });

  it("retries when the data server can't say what's at the key", async () => {
    // A refusal that is otherwise final: only "couldn't check" makes it worth
    // another hour.
    const { rpc } = fakeRpc(
      [{ ok: false, status: 400, data: { error: "InvalidRequest" } }],
      "unknown",
    );
    const result = await publishStoredDraft(input(rpc, { rkey: RESERVED }));
    expect(result).toMatchObject({ ok: false, retry: true });
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
  });

  it("reports the refusal when nothing is at the reserved key", async () => {
    const { rpc } = fakeRpc(
      [{ ok: false, status: 400, data: { error: "InvalidRequest" } }],
      "missing",
    );
    const result = await publishStoredDraft(input(rpc, { rkey: RESERVED }));
    expect(result).toMatchObject({ ok: false, retry: false });
  });

  it("never looks for an earlier attempt without a reserved key", async () => {
    const { rpc, got } = fakeRpc(refused(), { title: "x" });
    const result = await publishStoredDraft(input(rpc));
    expect(result).toMatchObject({ ok: false });
    expect(got).toEqual([]);
  });
});
