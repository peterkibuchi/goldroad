import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicHttpsUrl,
  isDid,
  isHandle,
  isValidCursor,
  listRecords,
  listRecordsPage,
  NotFoundError,
  parseAtUri,
  rkeyFromUri,
} from "../lib/atproto";

describe("atproto identifiers", () => {
  it("accepts real handles", () => {
    for (const h of ["alice.bsky.social", "bnewbold.net", "a-b.example.co"])
      expect(isHandle(h)).toBe(true);
  });
  it("rejects malformed handles", () => {
    for (const h of [
      "",
      "nodots",
      ".lead.dot",
      "sp ace.com",
      "-a.com",
      "a-.com",
    ])
      expect(isHandle(h)).toBe(false);
  });
  it("validates DIDs", () => {
    expect(isDid("did:plc:z72i7hdynmk6r22z27h6tvur")).toBe(true);
    expect(isDid("did:web:example.com")).toBe(true);
    expect(isDid("did:foo:bar")).toBe(false);
    expect(isDid("not-a-did")).toBe(false);
  });
});

describe("assertPublicHttpsUrl (SSRF guard)", () => {
  it("accepts normal public https hosts", () => {
    expect(assertPublicHttpsUrl("https://example.com/x").hostname).toBe(
      "example.com",
    );
    expect(
      assertPublicHttpsUrl("https://shiitake.us-east.host.bsky.network")
        .hostname,
    ).toBe("shiitake.us-east.host.bsky.network");
  });

  it("normalizes case and trailing dots", () => {
    expect(assertPublicHttpsUrl("https://Example.COM./x").hostname).toBe(
      "example.com",
    );
  });

  it("rejects non-https, explicit ports, and userinfo", () => {
    for (const bad of [
      "http://example.com/",
      "ftp://example.com/",
      "https://example.com:8443/",
      "https://user@example.com/",
      "https://user:pass@example.com/",
      "not a url",
    ])
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(NotFoundError);
  });

  it("rejects loopback, IP literals, and internal names", () => {
    for (const bad of [
      "https://localhost/",
      "https://localhost./", // trailing-dot trick
      "https://foo.localhost/",
      "https://127.0.0.1/",
      "https://127.1/",
      "https://[::1]/",
      "https://10.0.0.5/",
      "https://169.254.169.254/", // cloud metadata
      "https://0x7f000001/",
      "https://2130706433/",
      "https://intranet/", // single label
    ])
      expect(() => assertPublicHttpsUrl(bad), bad).toThrow(NotFoundError);
  });
});

describe("listRecords", () => {
  const goodEntry = {
    uri: "at://did:plc:fake0000000000writer0000/site.standard.document/3abc2345678de",
    cid: "bafyfakecid",
    value: { title: "A post" },
  };

  // A real Response, not a hand-rolled double: these reads are byte-capped, so
  // the body is streamed and content-length consulted. An object with only
  // `json()` would pass a test the production path could never satisfy.
  function mockFetch(payload: unknown, ok = true) {
    const fn = vi.fn(
      async (..._args: [URL | string, RequestInit?]) =>
        new Response(JSON.stringify(payload), { status: ok ? 200 : 404 }),
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps records and composes a guarded XRPC URL", async () => {
    const fn = mockFetch({ records: [goodEntry] });
    const records = await listRecords<{ title?: string }>(
      "https://pds.example",
      "did:plc:fake0000000000writer0000",
      "site.standard.document",
    );
    expect(records).toEqual([goodEntry]);
    const url = String(fn.mock.calls[0]?.[0]);
    expect(url).toContain(
      "https://pds.example/xrpc/com.atproto.repo.listRecords?",
    );
    expect(url).toContain("collection=site.standard.document");
    expect(url).toContain("limit=50");
    expect(url).not.toContain("reverse");
  });

  it("passes reverse and clamps limit to the 50-record cap", async () => {
    const fn = mockFetch({ records: [] });
    await listRecords(
      "https://pds.example",
      "did:plc:fake0000000000writer0000",
      "c",
      { limit: 999, reverse: true },
    );
    const url = String(fn.mock.calls[0]?.[0]);
    expect(url).toContain("limit=50");
    expect(url).toContain("reverse=true");
  });

  it("drops malformed entries instead of trusting the PDS response shape", async () => {
    mockFetch({
      records: [
        goodEntry,
        null,
        "junk",
        { uri: 42 },
        { value: {} },
        { uri: "at://x", value: null },
        // no cid: the ListedRecord type promises one (strongRefs are built
        // from it) — the guard must not lie.
        { uri: "at://x/c/r", value: { title: "no cid" } },
      ],
    });
    const records = await listRecords(
      "https://pds.example",
      "did:plc:fake0000000000writer0000",
      "site.standard.document",
    );
    expect(records).toEqual([goodEntry]);
  });

  it("returns [] when the records field is missing", async () => {
    mockFetch({});
    await expect(
      listRecords(
        "https://pds.example",
        "did:plc:fake0000000000writer0000",
        "c",
      ),
    ).resolves.toEqual([]);
  });

  it("throws NotFoundError on non-OK responses", async () => {
    mockFetch({}, false);
    await expect(
      listRecords(
        "https://pds.example",
        "did:plc:fake0000000000writer0000",
        "c",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses non-public PDS hosts (SSRF guard)", async () => {
    mockFetch({ records: [] });
    await expect(
      listRecords("https://localhost", "did:plc:fake0000000000writer0000", "c"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listRecordsPage — cursor mapping", () => {
  const did = "did:plc:fake0000000000writer0000";
  const entry = (rkey: string) => ({
    uri: `at://${did}/site.standard.document/${rkey}`,
    cid: "bafyfakecid",
    value: { title: rkey },
  });

  function mockFetch(payload: unknown) {
    const fn = vi.fn(
      async (..._args: [URL | string, RequestInit?]) =>
        new Response(JSON.stringify(payload)),
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the PDS cursor on a full page and sends it back on the next call", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      entry(`3abc23456${String(i).padStart(4, "0")}`),
    );
    const fn = mockFetch({ records: fullPage, cursor: "3abc2345678de" });
    const first = await listRecordsPage("https://pds.example", did, "c");
    expect(first.records).toHaveLength(50);
    expect(first.cursor).toBe("3abc2345678de");

    await listRecordsPage("https://pds.example", did, "c", {
      cursor: first.cursor ?? undefined,
    });
    expect(String(fn.mock.calls[1]?.[0])).toContain("cursor=3abc2345678de");
  });

  it("suppresses the cursor on a short page — never offers an empty older page", async () => {
    mockFetch({ records: [entry("3abc2345678de")], cursor: "3abc2345678de" });
    const page = await listRecordsPage("https://pds.example", did, "c");
    expect(page.cursor).toBeNull();
  });

  it("ignores malformed cursors from the PDS and from callers", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      entry(`3abc23456${String(i).padStart(4, "0")}`),
    );
    mockFetch({ records: fullPage, cursor: { $evil: true } });
    const page = await listRecordsPage("https://pds.example", did, "c");
    expect(page.cursor).toBeNull();

    const fn = mockFetch({ records: [] });
    await listRecordsPage("https://pds.example", did, "c", {
      cursor: "bad\x00cursor",
    });
    expect(String(fn.mock.calls[0]?.[0])).not.toContain("cursor=");
  });

  it("listRecords stays a records-only view over the same page", async () => {
    mockFetch({ records: [entry("3abc2345678de")], cursor: "x" });
    await expect(
      listRecords("https://pds.example", did, "c"),
    ).resolves.toHaveLength(1);
  });
});

describe("isValidCursor", () => {
  it("accepts opaque PDS cursors", () => {
    expect(isValidCursor("3lyk73wxnok2f")).toBe(true);
    expect(isValidCursor("2026-07-24T00:00:00Z/abc")).toBe(true);
  });

  it("rejects non-strings, empties, control chars, and oversized values", () => {
    expect(isValidCursor(undefined)).toBe(false);
    expect(isValidCursor(42)).toBe(false);
    expect(isValidCursor("")).toBe(false);
    expect(isValidCursor("a\x00b")).toBe(false);
    expect(isValidCursor("a\nb")).toBe(false);
    // C1 range too (NEL etc.), not just C0 + DEL — adopted from review.
    expect(isValidCursor("a\u0085b")).toBe(false);
    expect(isValidCursor("a\x7fb")).toBe(false);
    expect(isValidCursor("x".repeat(513))).toBe(false);
  });
});

describe("rkeyFromUri", () => {
  it("extracts the record key", () => {
    expect(
      rkeyFromUri(
        "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
      ),
    ).toBe("3abc2345678de");
  });
  it("rejects empty or invalid tails", () => {
    expect(rkeyFromUri("at://did:plc:x/collection/")).toBeNull();
    expect(rkeyFromUri("")).toBeNull();
    expect(rkeyFromUri("at://did:plc:x/collection/bad key")).toBeNull();
  });
  it("rejects the reserved record keys . and ..", () => {
    expect(rkeyFromUri("at://did:plc:x/collection/.")).toBeNull();
    expect(rkeyFromUri("at://did:plc:x/collection/..")).toBeNull();
    // dots inside a longer key stay legal
    expect(rkeyFromUri("at://did:plc:x/collection/v1.2")).toBe("v1.2");
  });
});

describe("parseAtUri", () => {
  // Patterned fake, but shape-valid: did:plc requires 24 base32 chars (no 0/1/8/9).
  const did = "did:plc:fakefakefakefakefakefake";

  it("parses a well-formed record URI", () => {
    expect(
      parseAtUri(`at://${did}/site.standard.publication/3abc2345678de`),
    ).toEqual({
      did,
      collection: "site.standard.publication",
      rkey: "3abc2345678de",
    });
  });

  it("rejects handles as authority (callers resolve PDS by DID)", () => {
    expect(
      parseAtUri("at://writer.example/site.standard.document/3abc"),
    ).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(parseAtUri("")).toBeNull();
    expect(parseAtUri("https://example.com/a/b")).toBeNull();
    expect(parseAtUri(`at://${did}`)).toBeNull();
    expect(parseAtUri(`at://${did}/collection.only`)).toBeNull();
    expect(parseAtUri(`at://${did}/c/3abc/extra`)).toBeNull();
    expect(parseAtUri(`at://${did}/bad collection/3abc`)).toBeNull();
    expect(parseAtUri(`at://${did}/c/bad key`)).toBeNull();
  });

  it("rejects non-NSID collections (single segment, empty segments)", () => {
    expect(parseAtUri(`at://${did}/c/3abc`)).toBeNull();
    expect(parseAtUri(`at://${did}/two.segments/3abc`)).toBeNull();
    expect(parseAtUri(`at://${did}/com..example/3abc`)).toBeNull();
    expect(parseAtUri(`at://${did}/com.example./3abc`)).toBeNull();
    expect(parseAtUri(`at://${did}/.com.example/3abc`)).toBeNull();
  });
});
