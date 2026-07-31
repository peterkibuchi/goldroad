// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { Route } from "../routes/img.$did.$cid";
import { handlerOf } from "./support/route-handler";

/**
 * Integration tests for the /img/$did/$cid handler itself (the guards it
 * composes are unit-tested in blob.test.ts): cache miss→hit flow, header
 * shaping, and the every-rejection-is-a-404 invariant. `fetch` and the
 * Workers `caches.default` are mocked; everything else is the real handler.
 */

// A well-formed did:plc — the suffix must be 24 chars of base32 [a-z2-7].
const DID = "did:plc:fake2222222222writer2222";
const CID = "bafkreicanarycanarycanarycanarycanarycanary";
const PDS = "https://pds.example";
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]); // jpeg-ish

const GET = handlerOf<{
  request: Request;
  params: { did: string; cid: string };
}>(Route, "GET");

function call(did: string, cid: string) {
  return GET({
    request: new Request(
      `http://127.0.0.1:3000/img/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`,
    ),
    params: { did, cid },
  });
}

const didDoc = {
  service: [
    {
      id: "#atproto_pds",
      type: "AtprotoPersonalDataServer",
      serviceEndpoint: PDS,
    },
  ],
};

/** fetch mock routing plc.directory → DID doc, PDS → the blob response. */
function mockFetch(
  blobResponse: () => Response,
  didDocResponse: () => Response = () =>
    new Response(JSON.stringify(didDoc), { status: 200 }),
) {
  const fn = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.startsWith("https://plc.directory/")) return didDocResponse();
    if (url.startsWith(`${PDS}/xrpc/com.atproto.sync.getBlob`))
      return blobResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Minimal Workers-cache stand-in over a Map. */
function mockCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (url: URL | string) => store.get(String(url))),
    put: vi.fn(async (url: URL | string, res: Response) => {
      store.set(String(url), res);
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return cache;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/img/$did/$cid — happy path + cache flow", () => {
  it("serves the blob with hardened headers and populates the cache", async () => {
    const fetchFn = mockFetch(
      () =>
        new Response(BYTES, {
          status: 200,
          // parameters must be stripped from the served content-type
          headers: { "content-type": "IMAGE/JPEG; charset=utf-8" },
        }),
    );
    const cache = mockCache();

    const res = await call(DID, CID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2); // DID doc + getBlob
  });

  it("serves from the cache without touching the network on a hit", async () => {
    const fetchFn = mockFetch(
      () =>
        new Response(BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    mockCache();

    await call(DID, CID); // miss → fetch + put
    const second = await call(DID, CID); // hit
    expect(second.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2); // unchanged: no third call
  });
});

describe("/img/$did/$cid — every rejection is a plain 404", () => {
  it("404s malformed did/cid without any network call", async () => {
    const fetchFn = mockFetch(() => new Response(null, { status: 500 }));
    mockCache();
    for (const [did, cid] of [
      ["not-a-did", CID],
      [DID, "../../../etc/passwd"],
      [DID, "short"],
      ["", ""],
    ] as const) {
      expect((await call(did, cid)).status).toBe(404);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("404s a lone % in the path (URIError) instead of 5xxing", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    mockCache();
    const res = await GET({
      request: new Request("http://127.0.0.1:3000/img/%/x"),
      params: { did: "%", cid: "%zz" },
    });
    expect(res.status).toBe(404);
  });

  it("404s when the DID document fetch fails", async () => {
    mockFetch(
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 404 }),
    );
    mockCache();
    expect((await call(DID, CID)).status).toBe(404);
  });

  it("404s upstream getBlob failures without caching them", async () => {
    mockFetch(() => new Response("BlobNotFound", { status: 400 }));
    const cache = mockCache();
    const res = await call(DID, CID);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("404s disallowed content types — SVG and text/html never serve", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf"]) {
      mockFetch(
        () =>
          new Response(BYTES, {
            status: 200,
            headers: { "content-type": type },
          }),
      );
      mockCache();
      expect((await call(DID, CID)).status, type).toBe(404);
    }
  });

  it("404s bodies over the serve cap via the declared content-length", async () => {
    mockFetch(
      () =>
        new Response(BYTES, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(100_000_000),
          },
        }),
    );
    mockCache();
    expect((await call(DID, CID)).status).toBe(404);
  });
});
