// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The theme intent on /api/publish — the ONLY write path a theme takes.
 *
 * What this pins: the four hexes become a lexicon-shaped
 * `site.standard.theme.basic` embedded in the writer's existing publication
 * record; every other field on that record survives, including ones other apps
 * wrote; "use the defaults" removes the field instead of storing our palette;
 * and a malformed submit changes nothing at all.
 */

const atproto = vi.hoisted(() => ({
  resolveDidIdentity: vi.fn(),
  listRecords: vi.fn(),
}));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

/** The XRPC calls the handler makes, in order. */
const posted = vi.hoisted(
  () =>
    [] as Array<{ nsid: string; options: { input: Record<string, unknown> } }>,
);
const postResult = vi.hoisted(() => ({ current: { ok: true, data: {} } }));
vi.mock("@atcute/client", () => ({
  Client: class {
    post(nsid: string, options: { input: Record<string, unknown> }) {
      posted.push({ nsid, options });
      return Promise.resolve(postResult.current);
    }
  },
}));

vi.mock("~/lib/oauth", () => ({
  createOAuthClient: () => ({ restore: () => Promise.resolve({}) }),
}));

const DID = "did:plc:fake2222222222writer2222";
vi.mock("~/lib/live-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-session")>()),
  readLiveSessionDid: () => Promise.resolve(DID),
}));

import { parseTheme } from "../lib/theme";
import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const PUB_URI = `at://${DID}/site.standard.publication/3lyk73wxnok2f`;

/** The writer's publication as their PDS returns it, carrying an icon and a
 * field no Goldroad code has ever written. */
function publication(extra: Record<string, unknown> = {}) {
  return {
    uri: PUB_URI,
    cid: "bafyreipublication",
    value: {
      $type: "site.standard.publication",
      name: "The Long Way",
      description: "Essays about slow software.",
      url: "https://trygoldroad.com/@writer.example",
      icon: { $type: "blob", ref: { $link: "bafkreiicon" } },
      preferences: { showInDiscover: false },
      ...extra,
    },
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

const COLOURS = {
  intent: "theme",
  background: "#faf7f0",
  foreground: "#1c1a18",
  accent: "#14548c",
  accentForeground: "#ffffff",
};

const EXPECTED = {
  background: { r: 250, g: 247, b: 240 },
  foreground: { r: 28, g: 26, b: 24 },
  accent: { r: 20, g: 84, b: 140 },
  accentForeground: { r: 255, g: 255, b: 255 },
};

/** The record the handler put, or null if it never wrote. */
function writtenRecord(): Record<string, unknown> | null {
  const put = posted.find((p) => p.nsid === "com.atproto.repo.putRecord");
  return (put?.options.input.record as Record<string, unknown>) ?? null;
}

function errorFrom(res: Response): string | null {
  const location = res.headers.get("location") ?? "";
  return new URL(location, "https://trygoldroad.com").searchParams.get("error");
}

beforeEach(() => {
  posted.length = 0;
  postResult.current = { ok: true, data: {} };
  atproto.resolveDidIdentity.mockResolvedValue({
    handle: "writer.example",
    pds: "https://pds.example.com",
  });
  atproto.listRecords.mockResolvedValue([publication()]);
});

describe("POST /api/publish — intent=theme", () => {
  it("writes the theme into the writer's own publication record", async () => {
    const res = await call(COLOURS);

    const put = posted.find((p) => p.nsid === "com.atproto.repo.putRecord");
    expect(put).toBeDefined();
    expect(put?.options.input.repo).toBe(DID);
    expect(put?.options.input.collection).toBe("site.standard.publication");
    expect(put?.options.input.rkey).toBe("3lyk73wxnok2f");
    expect(res.status).toBe(303);
    // `kind=theme` is what lets the landing page tell a theme save from a
    // profile save — both redirect here and both show the same confirmation, so
    // without the marker the two are indistinguishable downstream.
    expect(res.headers.get("location")).toBe("/settings?saved=1&kind=theme");
  });

  it("embeds it where the lexicon puts it, and it reads back as a theme", () => {
    return call(COLOURS).then(() => {
      const record = writtenRecord();
      expect(record?.basicTheme).toEqual({
        $type: "site.standard.theme.basic",
        accent: { $type: "site.standard.theme.color#rgb", ...EXPECTED.accent },
        accentForeground: {
          $type: "site.standard.theme.color#rgb",
          ...EXPECTED.accentForeground,
        },
        background: {
          $type: "site.standard.theme.color#rgb",
          ...EXPECTED.background,
        },
        foreground: {
          $type: "site.standard.theme.color#rgb",
          ...EXPECTED.foreground,
        },
      });
      // The round trip a reader's page actually makes.
      expect(parseTheme(record?.basicTheme)).toEqual(EXPECTED);
    });
  });

  it("creates no second record and no second collection", async () => {
    await call(COLOURS);
    // The publication embeds the theme, so one putRecord is the whole write.
    expect(posted).toHaveLength(1);
    expect(posted.every((p) => p.nsid === "com.atproto.repo.putRecord")).toBe(
      true,
    );
  });

  it("leaves every other field on the record alone, including other apps'", async () => {
    atproto.listRecords.mockResolvedValue([
      publication({ somethingLeafletWrote: { keep: "me" } }),
    ]);
    await call(COLOURS);
    const record = writtenRecord();
    expect(record?.name).toBe("The Long Way");
    expect(record?.description).toBe("Essays about slow software.");
    expect(record?.url).toBe("https://trygoldroad.com/@writer.example");
    expect(record?.icon).toEqual({
      $type: "blob",
      ref: { $link: "bafkreiicon" },
    });
    expect(record?.preferences).toEqual({ showInDiscover: false });
    expect(record?.somethingLeafletWrote).toEqual({ keep: "me" });
  });

  it("saves an unreadable palette rather than refusing it — we warn, they decide", async () => {
    await call({
      ...COLOURS,
      background: "#ffffff",
      foreground: "#fefefe",
    });
    expect(parseTheme(writtenRecord()?.basicTheme)).toEqual({
      ...EXPECTED,
      background: { r: 255, g: 255, b: 255 },
      foreground: { r: 254, g: 254, b: 254 },
    });
  });
});

describe("POST /api/publish — intent=theme, reset", () => {
  it("REMOVES basicTheme instead of storing our default palette", async () => {
    atproto.listRecords.mockResolvedValue([
      publication({
        basicTheme: {
          $type: "site.standard.theme.basic",
          accent: { r: 1, g: 1, b: 1 },
          accentForeground: { r: 2, g: 2, b: 2 },
          background: { r: 3, g: 3, b: 3 },
          foreground: { r: 4, g: 4, b: 4 },
        },
      }),
    ]);
    await call({ ...COLOURS, reset: "1" });
    const record = writtenRecord();
    expect(record).not.toBeNull();
    expect(record?.basicTheme).toBeUndefined();
    expect(record?.name).toBe("The Long Way");
  });

  it("ignores the colour fields entirely when resetting", async () => {
    await call({ ...COLOURS, reset: "1", accent: "#000000" });
    expect(writtenRecord()?.basicTheme).toBeUndefined();
  });
});

describe("POST /api/publish — intent=theme, refusals write nothing", () => {
  it("refuses a malformed colour without touching the record", async () => {
    const res = await call({ ...COLOURS, accent: "chartreuse" });
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("theme_invalid");
  });

  it("refuses a partial submit — three colours is not a palette", async () => {
    const { accentForeground: _dropped, ...partial } = COLOURS;
    const res = await call(partial);
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("theme_invalid");
  });

  it("says so plainly when there is no publication to attach a theme to", async () => {
    atproto.listRecords.mockResolvedValue([]);
    const res = await call(COLOURS);
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("theme_no_publication");
  });

  it("never touches a publication record another app owns", async () => {
    // Not one of our origins — findOwnPublication must not match it.
    atproto.listRecords.mockResolvedValue([
      {
        uri: `at://${DID}/site.standard.publication/3aaaaaaaaaaaa`,
        cid: "bafyreileaflet",
        value: {
          $type: "site.standard.publication",
          name: "Notes from Elsewhere",
          url: "https://elsewhere.leaflet.pub",
        },
      },
    ]);
    const res = await call(COLOURS);
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("theme_no_publication");
  });

  it("reports a PDS rejection instead of claiming a save", async () => {
    postResult.current = { ok: false, data: { error: "RateLimitExceeded" } };
    const res = await call(COLOURS);
    expect(errorFrom(res)).toBe("save_failed:RateLimitExceeded");
  });

  it("refuses a cross-site post before reading the session", async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(COLOURS)) form.append(key, value);
    const res = await POST({
      request: new Request("https://trygoldroad.com/api/publish", {
        method: "POST",
        body: form,
        headers: { origin: "https://evil.example" },
      }),
    });
    expect(res.status).toBe(403);
    expect(posted).toHaveLength(0);
  });
});

/**
 * Every intent here decides what to write by first reading the publication, so
 * each one has to tell "the writer has none" apart from "we couldn't ask". Read
 * as one, the answers are all wrong in a different way: the profile save creates
 * a permanent duplicate record, and the other two tell a writer who has a
 * publication that they don't.
 */
describe("POST /api/publish — a publication that can't be read", () => {
  beforeEach(() => {
    atproto.listRecords.mockRejectedValue(new Error("502 Bad Gateway"));
  });

  it("refuses the profile save instead of creating a second publication", async () => {
    const res = await call({
      intent: "publication",
      name: "The Long Way",
      description: "Essays about slow software.",
    });
    expect(posted.some((p) => p.nsid === "com.atproto.repo.createRecord")).toBe(
      false,
    );
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("save_failed:publication_unreadable");
  });

  it("refuses the theme save without claiming there is no publication", async () => {
    const res = await call(COLOURS);
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("save_failed:publication_unreadable");
  });

  it("refuses the URL move without claiming there is no publication", async () => {
    const res = await call({ intent: "migrate", returnTo: "settings" });
    expect(posted).toHaveLength(0);
    expect(errorFrom(res)).toBe("move_failed:publication_unreadable");
  });
});
