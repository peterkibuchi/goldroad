// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as atproto from "~/lib/atproto";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveReaderPds: vi.fn(async () => "https://pds.example"),
  refreshReaderPds: vi.fn(async () => null),
  resolveHandleToDid: vi.fn(async () => {
    throw new (await import("~/lib/atproto")).NotFoundError("gone");
  }),
  listRecords: vi.fn(async () => []),
  listRecordsPage: vi.fn(),
}));
const former = vi.hoisted(() => ({
  target: null as { ident: string; permanent: boolean } | null,
}));
vi.mock("~/lib/handle-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/handle-history")>()),
  findFormerHandle: vi.fn(async () => former.target),
}));
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  checkHidden: vi.fn(async () => false),
}));

import { isNotFound, isRedirect } from "@tanstack/react-router";

import { Route } from "../routes/@{$handle}.index";

type Options = {
  loader: (ctx: {
    params: { handle: string };
    deps: { cursor?: string };
  }) => Promise<Record<string, unknown>>;
  headers: (ctx: {
    loaderData?: unknown;
  }) => Record<string, string> | undefined;
  head: (ctx: { loaderData?: unknown }) => {
    meta?: Array<Record<string, string>>;
  };
};
const options = Route.options as unknown as Options;
const load = () => options.loader({ params: { handle: DID }, deps: {} });

describe("archive loader — how a failed listing is classified", () => {
  beforeEach(() => {
    vi.mocked(atproto.listRecords).mockResolvedValue([]);
  });

  it("asks for one archive page", async () => {
    vi.mocked(atproto.listRecordsPage).mockResolvedValue({
      records: [],
      cursor: null,
    });
    await load();
    expect(vi.mocked(atproto.listRecordsPage).mock.calls[0]?.[3]).toEqual({
      cursor: undefined,
      limit: atproto.LIST_PAGE_SIZE,
    });
  });

  it("shows a refused listing as an empty archive, cached as usual", async () => {
    vi.mocked(atproto.listRecordsPage).mockRejectedValue(
      new atproto.NotFoundError("400"),
    );
    const data = await load();
    expect(data.postsError).toBeNull();
    expect(options.headers({ loaderData: data })).toBeUndefined();
  });

  it("keeps a refusal out of the cache when the writer has moved PDS", async () => {
    vi.mocked(atproto.listRecordsPage).mockRejectedValue(
      new atproto.NotFoundError("400"),
    );
    vi.mocked(atproto.refreshReaderPds).mockResolvedValueOnce(
      "https://new-pds.example",
    );
    const data = await load();
    // This render read the old PDS; the next reads the new one, and an empty
    // archive mustn't stand in for it in the edge cache meanwhile.
    expect(atproto.refreshReaderPds).toHaveBeenCalledWith(
      DID,
      "https://pds.example",
    );
    expect(options.headers({ loaderData: data })).toEqual({
      "cache-control": "no-store",
    });
  });

  it("reports an unreachable PDS, and keeps the page out of the cache and the index", async () => {
    vi.mocked(atproto.listRecordsPage).mockRejectedValue(
      new atproto.ListUnavailableError("503"),
    );
    const data = await load();
    expect(data.postsError).toBe("unavailable");
    expect(options.headers({ loaderData: data })).toEqual({
      "cache-control": "no-store",
    });
    expect(options.head({ loaderData: data }).meta).toContainEqual({
      name: "robots",
      content: "noindex",
    });
  });

  it("reports a list too large to read, which may cache like any page", async () => {
    vi.mocked(atproto.listRecordsPage).mockRejectedValue(
      new atproto.ResponseTooLargeError("big"),
    );
    const data = await load();
    expect(data.postsError).toBe("too_large");
    expect(options.headers({ loaderData: data })).toBeUndefined();
  });

  it("keeps a page built on a failed publication read out of the cache", async () => {
    vi.mocked(atproto.listRecordsPage).mockResolvedValue({
      records: [],
      cursor: null,
    });
    vi.mocked(atproto.listRecords).mockImplementation(() =>
      Promise.reject(new atproto.ListUnavailableError("timeout")),
    );
    const data = await load();
    expect(options.headers({ loaderData: data })).toEqual({
      "cache-control": "no-store",
    });
  });
});

describe("archive loader — an old handle", () => {
  const loadStale = () =>
    options
      .loader({ params: { handle: "alice.example" }, deps: {} })
      .catch((e: unknown) => e);

  it("301s to the writer's current address", async () => {
    former.target = { ident: "alice.com", permanent: true };
    const thrown = (await loadStale()) as {
      options: { href: string; statusCode: number };
    };
    expect(isRedirect(thrown)).toBe(true);
    expect(thrown.options).toMatchObject({
      href: "/@alice.com",
      statusCode: 301,
    });
  });

  it("404s a handle with no history", async () => {
    former.target = null;
    expect(isNotFound(await loadStale())).toBe(true);
  });
});
