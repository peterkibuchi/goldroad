// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `intent=announce` on /api/publish — "Announce on Bluesky", the one place
 * Goldroad writes into a collection it does not own (app.bsky.feed.post).
 *
 * What this suite pins about the handler:
 *
 *  1. TWO WRITES, IN THIS ORDER. The post is created first; the document's
 *     `bskyPostRef` is then written back with the strongRef the PDS just
 *     returned, which is only knowable after the create. The write-back is
 *     best-effort: the announce is already public, so a failed one costs status
 *     honesty and never a duplicate post.
 *  2. THE WRITE-BACK NEVER CLOBBERS. It pins the version it read with
 *     swapRecord, and is skipped entirely when there is no CID to pin — an
 *     unconditional put would silently drop a concurrent edit's changes.
 *  3. ONLY SAME-REPO PUBLICATIONS ARE FOLLOWED. A `site` pointing into another
 *     identity's repo must not send us fetching their PDS.
 *  4. A REFUSED ANNOUNCE IS REPORTED. A writer who is told nothing presses the
 *     button again, and a scope failure needs a different answer from a retry.
 */

const atproto = vi.hoisted(() => ({
  resolveDidIdentity: vi.fn(),
  getRecordEntry: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

/** The XRPC calls the handler makes, in order. */
type Posted = { nsid: string; options: { input: Record<string, unknown> } };
const posted = vi.hoisted(() => [] as Posted[]);
type Reply = { ok: boolean; status: number; data: Record<string, unknown> };
const replies = vi.hoisted(() => new Map<string, Reply>());
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, options });
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

import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const RKEY = "3lyk73wxnok2f";
const PUB_RKEY = "3lyk00000pub0";
const DOC_URI = `at://${DID}/site.standard.document/${RKEY}`;
const DOC_CID = "bafyreidocument";
const PUB_URI = `at://${DID}/site.standard.publication/${PUB_RKEY}`;
const PUB_CID = "bafyreipublication";
const POST_URI = `at://${DID}/app.bsky.feed.post/3lz9999999999`;
const POST_CID = "bafyreibskypost";
const COVER_CID = "bafkreicoveraaaaaaaaaaaaaaaaaaaaaaaaaa";

const cover = (over: Record<string, unknown> = {}) => ({
  $type: "blob",
  ref: { $link: COVER_CID },
  mimeType: "image/jpeg",
  size: 4096,
  ...over,
});

/** The document as its PDS returns it, plus whatever a test overrides. */
function document(value: Record<string, unknown> = {}) {
  return {
    uri: DOC_URI,
    cid: DOC_CID,
    value: {
      $type: "site.standard.document",
      title: "The long way round",
      description: "Essays about slow software.",
      site: PUB_URI,
      path: `/${RKEY}`,
      publishedAt: "2026-07-01T09:00:00.000Z",
      textContent: "Some words.",
      ...value,
    },
  };
}

function publication(value: Record<string, unknown> = {}) {
  return {
    uri: PUB_URI,
    cid: PUB_CID,
    value: {
      $type: "site.standard.publication",
      name: "The Long Way",
      url: "https://trygoldroad.com/@writer.example",
      ...value,
    },
  };
}

/** Answers getRecordEntry per collection, the way the writer's PDS would. */
function repoHolds(
  entries: Partial<Record<"document" | "publication", unknown>>,
) {
  atproto.getRecordEntry.mockImplementation(
    async (_pds: string, _did: string, collection: string) => {
      const entry =
        collection === "site.standard.document"
          ? entries.document
          : entries.publication;
      if (!entry) throw new Error(`no ${collection}`);
      return entry;
    },
  );
}

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

const announce = (over: Record<string, string> = {}, headers?: HeadersInit) =>
  call({ intent: "announce", rkey: RKEY, ...over }, headers);

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "/", "https://trygoldroad.com");
}

function errorFrom(res: Response): string | null {
  return location(res).searchParams.get("error");
}

function callOf(nsid: string): Posted | undefined {
  return posted.find((p) => p.nsid === nsid);
}

/** The app.bsky.feed.post the handler built. */
function bskyPost(): Record<string, unknown> {
  const record = callOf("com.atproto.repo.createRecord")?.options.input.record;
  if (!record) throw new Error("no announce post was created");
  return record as Record<string, unknown>;
}

function externalEmbed(): Record<string, unknown> {
  const embed = bskyPost().embed as { external: Record<string, unknown> };
  return embed.external;
}

beforeEach(() => {
  posted.length = 0;
  replies.clear();
  restoreFails.current = false;
  session.did = DID;
  for (const fn of Object.values(atproto)) fn.mockReset();
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
  repoHolds({ document: document(), publication: publication() });
  // The PDS mints the post's key, so the create is where its strongRef comes
  // from — and the write-back below has nothing to write without it.
  replies.set("com.atproto.repo.createRecord", {
    ok: true,
    status: 200,
    data: { uri: POST_URI, cid: POST_CID },
  });
});

describe("POST /api/publish — intent=announce", () => {
  it("creates the post in the writer's repo and lets the PDS name it", async () => {
    const res = await announce();
    const created = callOf("com.atproto.repo.createRecord");
    expect(created?.options.input.repo).toBe(DID);
    expect(created?.options.input.collection).toBe("app.bsky.feed.post");
    // No rkey of ours: a Bluesky post needs no key we chose.
    expect(created?.options.input.rkey).toBeUndefined();
    expect(res.status).toBe(303);
    expect(location(res).pathname).toBe("/dashboard");
    expect(location(res).searchParams.get("announced")).toBe("3lz9999999999");
  });

  it("writes the post's ref back into the document, and only after creating it", async () => {
    await announce();
    // The write-back carries the strongRef the create returned, so this order
    // is the only one that can exist — and it is what lets the dashboard say
    // "Announced" from the record rather than from a table of ours.
    expect(posted.map((p) => p.nsid)).toEqual([
      "com.atproto.repo.createRecord",
      "com.atproto.repo.putRecord",
    ]);
    const put = callOf("com.atproto.repo.putRecord");
    expect(put?.options.input.collection).toBe("site.standard.document");
    expect(put?.options.input.rkey).toBe(RKEY);
    const record = put?.options.input.record as Record<string, unknown>;
    expect(record.bskyPostRef).toEqual({ uri: POST_URI, cid: POST_CID });
  });

  it("preserves the rest of the document, including a foreign content union", async () => {
    const content = { $type: "pub.leaflet.content", blocks: [] };
    repoHolds({
      document: document({ content, tags: ["slow-software"] }),
      publication: publication(),
    });
    await announce();
    const record = callOf("com.atproto.repo.putRecord")?.options.input
      .record as Record<string, unknown>;
    // Recording an announce is not an edit, so the not-editable rule does not
    // apply — but nothing may be dropped either.
    expect(record.content).toEqual(content);
    expect(record.tags).toEqual(["slow-software"]);
    expect(record.textContent).toBe("Some words.");
  });

  it("pins the version it read, so a concurrent edit wins instead of losing", async () => {
    await announce();
    expect(callOf("com.atproto.repo.putRecord")?.options.input.swapRecord).toBe(
      DOC_CID,
    );
  });

  it("SKIPS the write-back when there is no version to pin", async () => {
    // getRecord's CID is optional in the XRPC response shape, so this is a
    // state a real PDS can put us in.
    const { cid: _absent, ...noCid } = document();
    repoHolds({ document: noCid, publication: publication() });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await announce();
    quiet.mockRestore();
    // An unconditional put is the one way this could stomp a concurrent edit,
    // and losing the "Announced" badge is the cheaper of the two.
    expect(posted.map((p) => p.nsid)).toEqual([
      "com.atproto.repo.createRecord",
    ]);
    expect(location(res).searchParams.get("announced")).toBe("3lz9999999999");
  });

  it("still reports the announce when the write-back is rejected", async () => {
    replies.set("com.atproto.repo.putRecord", {
      ok: false,
      status: 400,
      data: { error: "InvalidSwap" },
    });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await announce();
    quiet.mockRestore();
    // The post is public already. An error here would invite a second press
    // and a second post.
    expect(errorFrom(res)).toBeNull();
    expect(location(res).searchParams.get("announced")).toBe("3lz9999999999");
  });
});

describe("POST /api/publish — intent=announce, what the post says", () => {
  it("links the canonical URL composed from the publication, not our fallback", async () => {
    await announce();
    const url = "https://trygoldroad.com/@writer.example/3lyk73wxnok2f";
    expect(bskyPost().text).toBe(`The long way round\n${url}`);
    expect(externalEmbed().uri).toBe(url);
  });

  it("falls back to a URL our reader really serves when composition fails", async () => {
    // A document with no path can't compose; /@<ident>/<rkey> is served for any
    // repo's document, so it is the honest answer rather than a dead link.
    repoHolds({
      document: document({ path: undefined }),
      publication: publication(),
    });
    await announce();
    expect(externalEmbed().uri).toBe(
      `https://trygoldroad.com/@writer.example/${RKEY}`,
    );
  });

  it("carries strongRefs to the document AND its publication, document first", async () => {
    await announce();
    // These refs are what make Bluesky render the enriched reader card; the
    // link facet alone renders nothing.
    expect(externalEmbed().associatedRefs).toEqual([
      { uri: DOC_URI, cid: DOC_CID },
      { uri: PUB_URI, cid: PUB_CID },
    ]);
  });

  it("announces without the publication ref when that record can't be read", async () => {
    repoHolds({ document: document() });
    await announce();
    expect(externalEmbed().associatedRefs).toEqual([
      { uri: DOC_URI, cid: DOC_CID },
    ]);
    // And the URL falls back rather than being composed from a record we never
    // read.
    expect(externalEmbed().uri).toBe(
      `https://trygoldroad.com/@writer.example/${RKEY}`,
    );
  });

  it("NEVER fetches a publication in another identity's repo", async () => {
    const foreign =
      "at://did:plc:fake4444444444other44444/site.standard.publication/3lzzz";
    repoHolds({
      document: document({ site: foreign }),
      publication: publication(),
    });
    await announce();
    // Following a cross-repo ref would mean this handler fetching a different
    // identity's PDS on a form field's say-so.
    for (const [, did] of atproto.getRecordEntry.mock.calls)
      expect(did).toBe(DID);
    expect(atproto.getRecordEntry).toHaveBeenCalledTimes(1);
    expect(externalEmbed().associatedRefs).toEqual([
      { uri: DOC_URI, cid: DOC_CID },
    ]);
  });

  it("reuses the document's cover as the card thumb", async () => {
    repoHolds({
      document: document({ coverImage: cover() }),
      publication: publication(),
    });
    await announce();
    expect(externalEmbed().thumb).toEqual(cover());
  });

  it("drops a cover the thumb lexicon would reject rather than losing the announce", async () => {
    repoHolds({
      document: document({ coverImage: cover({ size: 1_000_001 }) }),
      publication: publication(),
    });
    await announce();
    // An oversized thumb fails the whole post at the PDS.
    expect(externalEmbed().thumb).toBeUndefined();
    expect(callOf("com.atproto.repo.createRecord")).toBeDefined();
  });
});

describe("POST /api/publish — intent=announce, refusals write nothing", () => {
  it("refuses a key that is not a record key", async () => {
    for (const rkey of ["", ".", "a/b", "with space"]) {
      posted.length = 0;
      const res = await announce({ rkey });
      expect(posted).toHaveLength(0);
      expect(errorFrom(res)).toBe("missing_rkey");
    }
  });

  it("says the PDS could not be resolved instead of announcing a guess", async () => {
    atproto.resolveDidIdentity.mockResolvedValue({
      handle: "writer.example",
      pds: null,
    });
    const res = await announce();
    // Without a PDS the document can't be read, and a post announcing a URL we
    // never verified is worse than no post.
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("announce_failed:pds_unresolved");
  });

  it("says not_found when the document itself can't be read", async () => {
    repoHolds({});
    const res = await announce();
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("not_found");
  });

  it("tells the writer to re-connect when their grant predates the post scope", async () => {
    // app.bsky.feed.post was added to the requested scope after some sessions
    // were issued; those need a fresh sign-in, not another press.
    for (const status of [401, 403]) {
      posted.length = 0;
      replies.set("com.atproto.repo.createRecord", {
        ok: false,
        status,
        data: {},
      });
      const res = await announce();
      expect(errorFrom(res)).toBe("announce_scope");
      expect(location(res).searchParams.get("announced")).toBeNull();
    }
  });

  it("reports a PDS rejection instead of claiming an announce", async () => {
    replies.set("com.atproto.repo.createRecord", {
      ok: false,
      status: 400,
      data: { error: "InvalidRequest" },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await announce();
    quiet.mockRestore();
    expect(errorFrom(res)).toBe("announce_failed:InvalidRequest");
    expect(location(res).searchParams.get("announced")).toBeNull();
    // And nothing was written back: the document must not claim a post that
    // does not exist.
    expect(callOf("com.atproto.repo.putRecord")).toBeUndefined();
  });

  it("refuses a cross-site announce before reading the session", async () => {
    const res = await announce({}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(posted).toHaveLength(0);
    expect(atproto.resolveDidIdentity).not.toHaveBeenCalled();
  });

  it("refuses a signed-out announce", async () => {
    session.did = null;
    const res = await announce();
    expect([303, 401]).toContain(res.status);
    expect(posted).toHaveLength(0);
  });

  it("sends a dead session to sign-in rather than claiming an announce", async () => {
    restoreFails.current = true;
    const res = await announce();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/write?error=session_expired");
    expect(posted).toHaveLength(0);
  });
});
