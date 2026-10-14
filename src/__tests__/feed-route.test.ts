// @vitest-environment node
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hiddenSubjects } from "~/lib/moderation";
import { env } from "cloudflare:workers";

/**
 * Integration tests for the /@{$handle}/rss.xml handler: XML shape (parsed
 * back with a real parser), hostile-value escaping end-to-end, link
 * composition, takedown behavior (hidden author → 404, hidden record →
 * excluded), and the every-rejection-is-a-404 invariant. `fetch` is mocked
 * (handle resolution, DID doc, listRecords); hiddenSubjects is mocked (and a
 * truthy env.DB stubbed, mirroring img-moderation.test.ts) so takedown
 * outcomes are drivable without a live D1.
 */
const former = vi.hoisted(() => ({
  target: null as { ident: string; permanent: boolean } | null,
}));
vi.mock("~/lib/handle-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/handle-history")>()),
  formerHandleTarget: vi.fn(async () => former.target),
}));

vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  hiddenSubjects: vi.fn(async () => new Set<string>()),
}));

import { Route } from "../routes/@{$handle}.rss[.]xml";
import { handlerOf } from "./support/route-handler";

const DID = "did:plc:fake2222222222writer2222";
const PDS = "https://pds.example";
const PUB_AT_URI = `at://${DID}/site.standard.publication/3abc2345678de`;
const HOSTILE_TITLE = `Attack ]]><script>alert("pwn")</script>`;

const GET = handlerOf<{ request: Request; params: { handle: string } }>(
  Route,
  "GET",
);

function call(handle: string) {
  return GET({
    request: new Request(
      `http://127.0.0.1:3000/@${encodeURIComponent(handle)}/rss.xml`,
    ),
    params: { handle },
  });
}

function parseXml(xml: string): Document {
  const { DOMParser } = new JSDOM("").window;
  return new DOMParser().parseFromString(
    xml,
    "text/xml",
  ) as unknown as Document;
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

const publicationRecord = {
  uri: PUB_AT_URI,
  cid: "bafypubcid",
  value: {
    $type: "site.standard.publication",
    name: HOSTILE_TITLE,
    description: `"Essays" & <notes>`,
    url: "https://pub.example/@writer.example",
  },
};

// A second, newer publication in the same repo — documents may reference any
// of the author's publications, not just the oldest (which titles the channel).
const SECOND_PUB_AT_URI = `at://${DID}/site.standard.publication/3def2345678aa`;
const secondPublicationRecord = {
  uri: SECOND_PUB_AT_URI,
  cid: "bafypubcid2",
  value: {
    $type: "site.standard.publication",
    name: "Second Publication",
    url: "https://second.example/blog",
  },
};

const docRecords = [
  {
    // Older post; composes against its publication's URL — deliberately the
    // SECOND publication, not the oldest one that titles the channel.
    uri: `at://${DID}/site.standard.document/3aaa2345678aa`,
    cid: "bafydoc1",
    value: {
      $type: "site.standard.document",
      title: HOSTILE_TITLE,
      description: "An <excerpt> & summary",
      site: SECOND_PUB_AT_URI,
      path: "/3aaa2345678aa",
      publishedAt: "2026-07-20T12:30:00Z",
    },
  },
  {
    // Newer post; no site/path (composition fails → our reading surface) and
    // no description (→ textContent excerpt). The uri's authority LIES about
    // the DID — the guid must still be minted from the real one.
    uri: "at://did:plc:evil2222222222imposter22/site.standard.document/3bbb2345678bb",
    cid: "bafydoc2",
    value: {
      $type: "site.standard.document",
      title: "Plain follow-up",
      textContent: "# Heading\n\nSome **bold** body text with detail.",
      publishedAt: "2026-07-22T09:00:00Z",
    },
  },
  {
    // No title → dropped (page parity).
    uri: `at://${DID}/site.standard.document/3ccc2345678cc`,
    cid: "bafydoc3",
    value: { $type: "site.standard.document", textContent: "untitled" },
  },
];

/** fetch mock: handle resolution → DID doc → per-collection listRecords. */
function mockFetch({
  resolveStatus = 200,
  publications = [publicationRecord, secondPublicationRecord],
  documents = docRecords,
}: {
  resolveStatus?: number;
  publications?: unknown[];
  documents?: unknown[];
} = {}) {
  const fn = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.startsWith("https://public.api.bsky.app/xrpc/")) {
      return new Response(JSON.stringify({ did: DID }), {
        status: resolveStatus,
      });
    }
    if (url.startsWith("https://plc.directory/")) {
      return new Response(JSON.stringify(didDoc), { status: 200 });
    }
    if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)) {
      const collection = new URL(url).searchParams.get("collection");
      const records =
        collection === "site.standard.publication" ? publications : documents;
      return new Response(JSON.stringify({ records }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  former.target = null;
  vi.unstubAllGlobals();
  vi.mocked(hiddenSubjects).mockReset();
  vi.mocked(hiddenSubjects).mockResolvedValue(new Set());
  // biome-ignore lint/suspicious/noExplicitAny: mutating the test env stub
  delete (env as any).DB;
});

describe("/@{$handle}/rss.xml — happy path", () => {
  it("serves well-formed RSS 2.0 with escaped third-party values", async () => {
    mockFetch();
    const res = await call("writer.example");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const xml = await res.text();
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("]]>");

    const doc = parseXml(xml);
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    // Hostile publication name round-trips as inert text.
    expect(doc.querySelector("channel > title")?.textContent).toBe(
      HOSTILE_TITLE,
    );
    expect(doc.querySelector("channel > description")?.textContent).toBe(
      `"Essays" & <notes>`,
    );
    // Channel + self URLs are minted from the canonical origin.
    expect(doc.querySelector("channel > link")?.textContent).toBe(
      "https://trygoldroad.com/@writer.example",
    );
    expect(
      doc
        .getElementsByTagNameNS("http://www.w3.org/2005/Atom", "link")[0]
        ?.getAttribute("href"),
    ).toBe("https://trygoldroad.com/@writer.example/rss.xml");
  });

  it("lists titled documents newest-first, dropping title-less records", async () => {
    mockFetch();
    const doc = parseXml(await (await call("writer.example")).text());
    const items = Array.from(doc.querySelectorAll("item"));
    expect(items).toHaveLength(2); // the untitled record is dropped
    expect(items[0].querySelector("title")?.textContent).toBe(
      "Plain follow-up",
    );
    expect(items[1].querySelector("title")?.textContent).toBe(HOSTILE_TITLE);
    expect(items[1].querySelector("pubDate")?.textContent).toBe(
      "Mon, 20 Jul 2026 12:30:00 GMT",
    );
  });

  it("links the composed canonical URL, falling back to our reading surface", async () => {
    mockFetch();
    const doc = parseXml(await (await call("writer.example")).text());
    const items = Array.from(doc.querySelectorAll("item"));
    // No site/path → our own surface.
    expect(items[0].querySelector("link")?.textContent).toBe(
      "https://trygoldroad.com/@writer.example/3bbb2345678bb",
    );
    // site → that publication's url + path (composed canonical), resolved
    // against ANY of the author's publications.
    expect(items[1].querySelector("link")?.textContent).toBe(
      "https://second.example/blog/3aaa2345678aa",
    );
  });

  it("mints guids from the validated DID even when the PDS lies in its uris", async () => {
    mockFetch();
    const doc = parseXml(await (await call("writer.example")).text());
    const guids = Array.from(doc.querySelectorAll("item > guid"));
    expect(guids.map((g) => g.textContent)).toEqual([
      `at://${DID}/site.standard.document/3bbb2345678bb`,
      `at://${DID}/site.standard.document/3aaa2345678aa`,
    ]);
    for (const guid of guids) {
      expect(guid.getAttribute("isPermaLink")).toBe("false");
    }
  });

  it("uses the record description, else a plain-text excerpt of textContent", async () => {
    mockFetch();
    const doc = parseXml(await (await call("writer.example")).text());
    const items = Array.from(doc.querySelectorAll("item"));
    expect(items[0].querySelector("description")?.textContent).toBe(
      "Heading Some bold body text with detail.",
    );
    expect(items[1].querySelector("description")?.textContent).toBe(
      "An <excerpt> & summary",
    );
  });

  it("carries the full text of a long post, not just short ones", async () => {
    const body = `Opening line.\n\n${"A long paragraph of an essay. ".repeat(300)}\n\nClosing line.`;
    expect(body.length).toBeGreaterThan(8_000);
    mockFetch({
      documents: [
        {
          uri: `at://${DID}/site.standard.document/3ddd2345678dd`,
          cid: "bafydoc4",
          value: {
            $type: "site.standard.document",
            title: "A long essay",
            content: {
              $type: "at.markpub.markdown",
              text: { markdown: body },
            },
            publishedAt: "2026-07-23T09:00:00Z",
          },
        },
      ],
    });
    const doc = parseXml(await (await call("writer.example")).text());
    const encoded = doc.getElementsByTagNameNS(
      "http://purl.org/rss/1.0/modules/content/",
      "encoded",
    )[0]?.textContent;
    expect(encoded).toContain("Opening line.");
    expect(encoded).toContain("Closing line.");
  });

  const essays = (count: number, chars: number) =>
    Array.from({ length: count }, (_, i) => ({
      uri: `at://${DID}/site.standard.document/3eee2345678${String(i).padStart(2, "a")}`,
      cid: `bafyessay${i}`,
      value: {
        $type: "site.standard.document",
        title: `Essay ${i}`,
        description: `Excerpt ${i}`,
        textContent: `Essay ${i}. ${"Word ".repeat(chars / 5)}`,
        publishedAt: new Date(Date.UTC(2026, 6, 20 - i)).toISOString(),
      },
    }));
  const encodedOf = (xml: string) =>
    Array.from(
      parseXml(xml).querySelectorAll("item"),
      (item) =>
        item.getElementsByTagNameNS(
          "http://purl.org/rss/1.0/modules/content/",
          "encoded",
        )[0]?.textContent ?? null,
    );

  it("renders cold misses newest-first under a budget, leaving the rest to excerpts", async () => {
    mockFetch({ documents: essays(4, 12_000) });
    const encoded = encodedOf(await (await call("writer.example")).text());
    expect(encoded[0]).toContain("Essay 0.");
    expect(encoded.slice(1)).toEqual([null, null, null]);
  });

  it("serves cached renders, and still bounds the feed's total full text", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("caches", {
      default: {
        match: async (key: string) =>
          store.has(key) ? new Response(store.get(key)) : undefined,
        put: async (key: string, response: Response) => {
          store.set(key, await response.text());
        },
      },
    });
    const documents = essays(20, 12_000);
    // Warm the cache the way earlier requests would have, one post each.
    for (const doc of documents) {
      mockFetch({ documents: [doc] });
      await call("writer.example");
    }
    mockFetch({ documents });
    const encoded = encodedOf(await (await call("writer.example")).text());
    const full = encoded.filter((html) => html !== null);
    // Every post is cached, so the render budget isn't what stops them: the
    // total full text is, at roughly 150,000 characters.
    expect(full.length).toBeGreaterThan(1);
    expect(full.length).toBeLessThan(20);
    expect(full.join("").length).toBeLessThanOrEqual(150_000);
    expect(encoded[0]).toContain("Essay 0.");
  });

  it("asks the PDS for one feed page of documents", async () => {
    const fetchMock = mockFetch();
    await call("writer.example");
    const list = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find(
        (url) =>
          url.searchParams.get("collection") === "site.standard.document",
      );
    expect(list?.searchParams.get("limit")).toBe("20");
  });

  it("serves a valid empty feed titled by ident when nothing is published", async () => {
    mockFetch({ publications: [], documents: [] });
    const res = await call("writer.example");
    expect(res.status).toBe(200);
    const doc = parseXml(await res.text());
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.querySelector("channel > title")?.textContent).toBe(
      "writer.example",
    );
    expect(doc.querySelector("channel > description")?.textContent).toBe(
      "Writing by @writer.example",
    );
    expect(doc.querySelectorAll("item")).toHaveLength(0);
  });
});

describe("/@{$handle}/rss.xml — 404 invariants", () => {
  it("404s an unknown handle (mirrors the publication page)", async () => {
    mockFetch({ resolveStatus: 404 });
    const res = await call("nobody.example");
    expect(res.status).toBe(404);
  });

  it("404s malformed idents without touching the network", async () => {
    const fetchFn = mockFetch();
    expect((await call("not-a-handle")).status).toBe(404);
    expect(
      (
        await GET({
          request: new Request("http://127.0.0.1:3000/@%zz/rss.xml"),
          params: { handle: "%zz" },
        })
      ).status,
    ).toBe(404);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("/@{$handle}/rss.xml — a failed listing", () => {
  it("answers 503 instead of an empty feed when the page is too large", async () => {
    const fn = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith("https://public.api.bsky.app/xrpc/"))
        return new Response(JSON.stringify({ did: DID }));
      if (url.startsWith("https://plc.directory/"))
        return new Response(JSON.stringify(didDoc));
      const collection = new URL(url).searchParams.get("collection");
      if (collection === "site.standard.publication")
        return new Response(JSON.stringify({ records: [] }));
      return new Response("x".repeat(1_000_001));
    });
    vi.stubGlobal("fetch", fn);
    const res = await call("writer.example");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/@{$handle}/rss.xml — a refused or failing listing", () => {
  function stubListing(status: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.startsWith("https://public.api.bsky.app/xrpc/"))
          return new Response(JSON.stringify({ did: DID }));
        if (url.startsWith("https://plc.directory/"))
          return new Response(JSON.stringify(didDoc));
        const collection = new URL(url).searchParams.get("collection");
        if (collection === "site.standard.publication")
          return new Response(JSON.stringify({ records: [] }));
        return new Response("{}", { status });
      }),
    );
  }

  it("serves an empty feed when the PDS refuses the listing", async () => {
    stubListing(400);
    const res = await call("writer.example");
    expect(res.status).toBe(200);
  });

  it("answers 503 with a retry hint when the PDS is down", async () => {
    stubListing(502);
    const res = await call("writer.example");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
  });

  it("still 404s a hidden author whose listing failed", async () => {
    stubListing(502);
    // biome-ignore lint/suspicious/noExplicitAny: mutating the test env stub
    (env as any).DB = {};
    vi.mocked(hiddenSubjects).mockResolvedValue(new Set([DID]));
    expect((await call("writer.example")).status).toBe(404);
  });
});

describe("/@{$handle}/rss.xml — an old handle", () => {
  it("301s a feed URL from before the writer changed handle", async () => {
    mockFetch({ resolveStatus: 400 });
    // biome-ignore lint/suspicious/noExplicitAny: mutating the test env stub
    (env as any).DB = {};
    former.target = { ident: "alice.com", permanent: true };
    const res = await call("writer.example");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/@alice.com/rss.xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

describe("/@{$handle}/rss.xml — takedowns", () => {
  it("404s the whole feed for a hidden author", async () => {
    mockFetch();
    // biome-ignore lint/suspicious/noExplicitAny: truthy binding so the guard runs
    (env as any).DB = {};
    vi.mocked(hiddenSubjects).mockResolvedValue(new Set([DID]));
    const res = await call("writer.example");
    expect(res.status).toBe(404);
  });

  it("excludes a hidden record while serving the rest", async () => {
    mockFetch();
    // biome-ignore lint/suspicious/noExplicitAny: truthy binding so the guard runs
    (env as any).DB = {};
    const hiddenUri = `at://${DID}/site.standard.document/3aaa2345678aa`;
    vi.mocked(hiddenSubjects).mockResolvedValue(new Set([hiddenUri]));
    const res = await call("writer.example");
    expect(res.status).toBe(200);
    const doc = parseXml(await res.text());
    const items = Array.from(doc.querySelectorAll("item"));
    expect(items).toHaveLength(1);
    expect(items[0].querySelector("guid")?.textContent).toBe(
      `at://${DID}/site.standard.document/3bbb2345678bb`,
    );
    // The check was handed OUR minted URIs (did + per-record at:// shapes) —
    // never the PDS-reported uris, which here lie about one record's DID.
    // The untitled record is dropped before the check (it can't be served).
    expect(hiddenSubjects).toHaveBeenCalledWith(expect.anything(), [
      DID,
      hiddenUri,
      `at://${DID}/site.standard.document/3bbb2345678bb`,
    ]);
  });

  it("fails open (still serves) when the takedown store errors", async () => {
    mockFetch();
    // biome-ignore lint/suspicious/noExplicitAny: truthy binding so the guard runs
    (env as any).DB = {};
    vi.mocked(hiddenSubjects).mockRejectedValue(new Error("d1 down"));
    const res = await call("writer.example");
    expect(res.status).toBe(200);
    expect(parseXml(await res.text()).querySelectorAll("item")).toHaveLength(2);
  });
});
