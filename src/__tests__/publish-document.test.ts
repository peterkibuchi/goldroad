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

const schedules = vi.hoisted(() => ({ deleteSchedulesForDraft: vi.fn() }));
vi.mock("~/lib/scheduled-posts", () => schedules);

import {
  findOwnPublication,
  publishStoredDraft,
  resolvePublicationSite,
} from "../lib/publish-document";

const DID = "did:plc:fake2222222222writer2222" as const;
const PUB_URI = `at://${DID}/site.standard.publication/3lyk73wxnok2f`;

type Posted = { nsid: string; input: Record<string, unknown> };

/** A stand-in for @atcute/client: records what was posted, answers as told. */
function fakeRpc(
  answers: Array<{ ok: boolean; status?: number; data?: unknown }> = [],
) {
  const posted: Posted[] = [];
  const rpc = {
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
  return { rpc, posted };
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
});

describe("resolvePublicationSite", () => {
  it("attaches to the writer's own publication when they have one", async () => {
    const { rpc, posted } = fakeRpc();
    const site = await resolvePublicationSite({
      rpc,
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
