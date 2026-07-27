// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  assertImportableUrl,
  clampOriginalDate,
  detectPreview,
  discoverFeedUrls,
  extractFirstImageUrl,
  type FetchLike,
  fetchCoverCandidate,
  fetchImportable,
  guidHash,
  ImportError,
  isCrossSite,
  looksLikeHtml,
  MAX_FEED_BYTES,
  MAX_ITEM_CONTENT_CHARS,
  MAX_ITEMS_PER_RUN,
  MAX_REDIRECT_HOPS,
  parseFeedDocument,
  readFeedBody,
} from "../lib/import";

// ---------------------------------------------------------------- SSRF guard

describe("assertImportableUrl", () => {
  it("accepts a public https feed URL", () => {
    expect(assertImportableUrl("https://writer.substack.com/feed").href).toBe(
      "https://writer.substack.com/feed",
    );
  });

  it.each([
    "http://writer.substack.com/feed", // not https
    "https://writer.substack.com:8443/feed", // explicit port
    "https://127.0.0.1/feed", // IP literal
    "https://localhost/feed", // single label
    "https://user:pass@writer.example/feed", // userinfo
    "ftp://writer.example/feed", // wrong scheme
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertImportableUrl(url)).toThrow(ImportError);
  });

  it("refuses our own hostnames (canonical + workers.dev)", () => {
    for (const url of [
      "https://trygoldroad.com/feed",
      "https://goldroad.kibuchi.workers.dev/feed",
      "https://anything.workers.dev/rss",
    ]) {
      expect(() => assertImportableUrl(url)).toThrow(ImportError);
    }
  });

  it("refuses over-long URLs before any parsing", () => {
    expect(() =>
      assertImportableUrl(`https://a.example/${"x".repeat(2100)}`),
    ).toThrow(ImportError);
  });
});

// --------------------------------------------------------- redirect handling

function fakeFetch(
  routes: Record<string, () => Response>,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl: FetchLike = async (url: string) => {
    calls.push(url);
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  };
  return Object.assign(impl, { calls });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 301, headers: { location } });
}

describe("fetchImportable — manual redirects, every hop re-validated", () => {
  it("follows a public redirect and reports the final URL", async () => {
    const impl = fakeFetch({
      "https://a.example/feed": () => redirectTo("https://b.example/feed"),
      "https://b.example/feed": () => new Response("ok"),
    });
    const { res, finalUrl } = await fetchImportable(
      "https://a.example/feed",
      impl,
    );
    expect(res.status).toBe(200);
    expect(finalUrl.href).toBe("https://b.example/feed");
  });

  it("resolves relative redirect targets against the current URL", async () => {
    const impl = fakeFetch({
      "https://a.example/blog": () => redirectTo("/feed"),
      "https://a.example/feed": () => new Response("ok"),
    });
    const { finalUrl } = await fetchImportable("https://a.example/blog", impl);
    expect(finalUrl.href).toBe("https://a.example/feed");
  });

  it("kills the 30x-to-internal-host bypass (redirect hop re-validated)", async () => {
    for (const target of [
      "http://a.example/feed",
      "https://127.0.0.1/feed",
      "https://localhost/x",
      "https://trygoldroad.com/x",
    ]) {
      const impl = fakeFetch({
        "https://a.example/feed": () => redirectTo(target),
      });
      await expect(
        fetchImportable("https://a.example/feed", impl),
      ).rejects.toThrow(ImportError);
      // …and the internal target was never fetched.
      expect(impl.calls).toEqual(["https://a.example/feed"]);
    }
  });

  it(`gives up after ${MAX_REDIRECT_HOPS} hops`, async () => {
    const impl = fakeFetch({
      "https://a.example/1": () => redirectTo("https://a.example/2"),
      "https://a.example/2": () => redirectTo("https://a.example/3"),
      "https://a.example/3": () => redirectTo("https://a.example/4"),
      "https://a.example/4": () => redirectTo("https://a.example/5"),
      "https://a.example/5": () => new Response("never reached"),
    });
    await expect(
      fetchImportable("https://a.example/1", impl),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("maps network failures to fetch_failed", async () => {
    const impl: FetchLike = async () => {
      throw new TypeError("network down");
    };
    await expect(
      fetchImportable("https://a.example/feed", impl),
    ).rejects.toMatchObject({ code: "fetch_failed" });
  });
});

describe("readFeedBody — the streaming byte cap", () => {
  it("rejects a body over the cap even without a content-length", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk); // endless 64 KB chunks
      },
    });
    const res = new Response(stream);
    res.headers.delete("content-length");
    await expect(readFeedBody(res)).rejects.toMatchObject({
      code: "feed_too_large",
    });
  });

  it("rejects a lying content-length via the fast path", async () => {
    const res = new Response("tiny", {
      headers: { "content-length": String(MAX_FEED_BYTES + 1) },
    });
    await expect(readFeedBody(res)).rejects.toMatchObject({
      code: "feed_too_large",
    });
  });

  it("returns the decoded text under the cap", async () => {
    await expect(readFeedBody(new Response("<rss/>"))).resolves.toBe("<rss/>");
  });
});

// -------------------------------------------------------------- feed parsing

const LONG_BODY = `<p>${"real words ".repeat(120)}</p>`;

function rssFeed(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>My Newsletter</title>
  <link>https://writer.substack.com</link>
  ${items}
</channel>
</rss>`;
}

const FULL_ITEM = `<item>
  <title>A full post</title>
  <link>https://writer.substack.com/p/full</link>
  <guid isPermaLink="false">guid-full</guid>
  <pubDate>Mon, 06 Jan 2025 12:00:00 GMT</pubDate>
  <description>teaser</description>
  <content:encoded><![CDATA[${LONG_BODY}]]></content:encoded>
</item>`;

const TEASER_ITEM = `<item>
  <title>A paywalled post</title>
  <link>https://writer.substack.com/p/gated</link>
  <guid isPermaLink="false">guid-gated</guid>
  <pubDate>Tue, 07 Jan 2025 12:00:00 GMT</pubDate>
  <content:encoded><![CDATA[${LONG_BODY}<p><a href="https://writer.substack.com/p/gated">Read more</a></p>]]></content:encoded>
</item>`;

describe("parseFeedDocument — RSS", () => {
  const feed = parseFeedDocument(rssFeed(FULL_ITEM + TEASER_ITEM));

  it("maps title/link/guid/date and carries the FULL content:encoded HTML", () => {
    expect(feed).not.toBeNull();
    expect(feed?.title).toBe("My Newsletter");
    const [full, gated] = feed?.items ?? [];
    expect(full.title).toBe("A full post");
    expect(full.link).toBe("https://writer.substack.com/p/full");
    expect(full.guid).toBe("guid-full");
    expect(full.publishedAt).toBe("2025-01-06T12:00:00.000Z");
    expect(full.contentHtml).toContain("real words");
    expect(full.contentHtml).toContain("<p>");
    expect(gated.guid).toBe("guid-gated");
  });

  it("flags the trailing read-more self-link as a preview; full stays full", () => {
    const [full, gated] = feed?.items ?? [];
    expect(full.preview).toBe(false);
    expect(gated.preview).toBe(true);
  });

  it("falls back to <description> when content:encoded is absent", () => {
    const parsed = parseFeedDocument(
      rssFeed(
        `<item><guid>g1</guid><title>t</title><description>only this</description></item>`,
      ),
    );
    expect(parsed?.items[0].contentHtml).toBe("only this");
    expect(parsed?.items[0].preview).toBe(true); // teaser-length
  });

  it("skips items with no guid and no link (nothing to dedupe by)", () => {
    const parsed = parseFeedDocument(
      rssFeed(`<item><title>ghost</title></item>${FULL_ITEM}`),
    );
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0].guid).toBe("guid-full");
  });

  it("uses the link as the guid when <guid> is absent", () => {
    const parsed = parseFeedDocument(
      rssFeed(
        `<item><title>t</title><link>https://writer.substack.com/p/x</link></item>`,
      ),
    );
    expect(parsed?.items[0].guid).toBe("https://writer.substack.com/p/x");
  });

  it(`caps at ${MAX_ITEMS_PER_RUN} items and reports the real total`, () => {
    const many = Array.from(
      { length: 25 },
      (_, i) =>
        `<item><guid>g${i}</guid><title>p${i}</title><content:encoded><![CDATA[${LONG_BODY}]]></content:encoded></item>`,
    ).join("");
    const parsed = parseFeedDocument(rssFeed(many));
    expect(parsed?.items).toHaveLength(MAX_ITEMS_PER_RUN);
    expect(parsed?.totalItems).toBe(25);
  });

  it("caps runaway item content and flags the cut as a preview", () => {
    const huge = `<p>${"x".repeat(MAX_ITEM_CONTENT_CHARS + 100)}</p>`;
    const parsed = parseFeedDocument(
      rssFeed(
        `<item><guid>g</guid><title>t</title><content:encoded><![CDATA[${huge}]]></content:encoded></item>`,
      ),
    );
    expect(parsed?.items[0].contentHtml.length).toBe(MAX_ITEM_CONTENT_CHARS);
    expect(parsed?.items[0].preview).toBe(true);
  });

  it("drops non-https item links instead of storing them", () => {
    const parsed = parseFeedDocument(
      rssFeed(
        `<item><guid>g</guid><title>t</title><link>javascript:alert(1)</link></item>`,
      ),
    );
    expect(parsed?.items[0].link).toBeNull();
  });

  it("treats an item-less feed as a feed (empty), not as not-a-feed", () => {
    const parsed = parseFeedDocument(rssFeed(""));
    expect(parsed).toEqual({
      title: "My Newsletter",
      items: [],
      totalItems: 0,
    });
  });

  it("entity-bomb XML stays inert (no DTD expansion)", () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
${rssFeed(`<item><guid>g</guid><title>&lol2;&lol2;</title><description>x</description></item>`)}`;
    const parsed = parseFeedDocument(bomb);
    // Custom entities are NOT expanded — the title stays literal-sized.
    expect(parsed?.items[0].title.length).toBeLessThan(100);
  });
});

describe("parseFeedDocument — Atom", () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Entry one</title>
    <link rel="alternate" href="https://blog.example/one"/>
    <link rel="edit" href="https://blog.example/edit/one"/>
    <id>tag:blog.example,2025:one</id>
    <published>2025-02-01T08:00:00Z</published>
    <content type="html">&lt;p&gt;${"words ".repeat(150)}&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Summary-only entry</title>
    <link href="https://blog.example/two"/>
    <id>tag:blog.example,2025:two</id>
    <updated>2025-02-02T08:00:00Z</updated>
    <summary>short summary</summary>
  </entry>
</feed>`;
  const feed = parseFeedDocument(atom);

  it("maps entries: id, alternate link, published, html content", () => {
    expect(feed?.title).toBe("Atom Blog");
    const [one, two] = feed?.items ?? [];
    expect(one.guid).toBe("tag:blog.example,2025:one");
    expect(one.link).toBe("https://blog.example/one");
    expect(one.publishedAt).toBe("2025-02-01T08:00:00.000Z");
    expect(one.contentHtml).toContain("words");
    expect(one.preview).toBe(false);
    expect(two.contentHtml).toBe("short summary");
    expect(two.preview).toBe(true);
    expect(two.publishedAt).toBe("2025-02-02T08:00:00.000Z");
  });
});

describe("parseFeedDocument — not a feed", () => {
  it("returns null for HTML and junk", () => {
    expect(
      parseFeedDocument("<!doctype html><html><body>hi</body></html>"),
    ).toBeNull();
    expect(parseFeedDocument("plain text")).toBeNull();
    expect(parseFeedDocument("{}")).toBeNull();
  });
});

describe("detectPreview", () => {
  it("short text = preview; long text = full", () => {
    expect(detectPreview("<p>short</p>", null)).toBe(true);
    expect(detectPreview(LONG_BODY, null)).toBe(false);
  });

  it("trailing self-link = preview, even when long", () => {
    const html = `${LONG_BODY}<p><a href="https://w.example/p/post?utm=1">Read more</a></p>`;
    expect(detectPreview(html, "https://w.example/p/post")).toBe(true);
  });

  it("a trailing link to somewhere ELSE is not a preview", () => {
    const html = `${LONG_BODY}<p><a href="https://other.example/thing">related</a></p>`;
    expect(detectPreview(html, "https://w.example/p/post")).toBe(false);
  });
});

// ------------------------------------------------------------- autodiscovery

describe("looksLikeHtml / discoverFeedUrls", () => {
  it("sniffs HTML answers", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html>")).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?><rss/>')).toBe(false);
  });

  it("prefers link rel=alternate hints, resolved against the page URL", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="text/css" href="/style.css">
    </head><body/></html>`;
    const urls = discoverFeedUrls(html, new URL("https://blog.example/about"));
    expect(urls[0]).toBe("https://blog.example/feed.xml");
    expect(urls).not.toContain("https://blog.example/style.css");
  });

  it("falls back to the /feed and /rss/ conventions", () => {
    const urls = discoverFeedUrls("<html/>", new URL("https://blog.example/"));
    expect(urls).toContain("https://blog.example/feed");
    expect(urls).toContain("https://blog.example/rss/");
  });

  it("keeps the pasted path in play (medium.com/@user → /feed/@user pattern via path/feed)", () => {
    const urls = discoverFeedUrls(
      "<html/>",
      new URL("https://blog.example/sub"),
    );
    expect(urls).toContain("https://blog.example/sub/feed");
  });

  it("drops hints that point at hosts we refuse", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed">
      <link rel="alternate" type="application/atom+xml" href="https://trygoldroad.com/rss">
    </head></html>`;
    const urls = discoverFeedUrls(html, new URL("https://blog.example/"));
    expect(urls.every((u) => u.startsWith("https://blog.example/"))).toBe(true);
  });
});

// ------------------------------------------------------------------- helpers

describe("guidHash", () => {
  it("is a stable sha-256 hex", async () => {
    const a = await guidHash("guid-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await guidHash("guid-1")).toBe(a);
    expect(await guidHash("guid-2")).not.toBe(a);
  });
});

describe("extractFirstImageUrl", () => {
  it("finds the first markdown image with a public https URL", () => {
    const md = `intro\n\n![alt text](https://cdn.example/img.jpg)\n\n![two](https://cdn.example/2.png)`;
    expect(extractFirstImageUrl(md)).toBe("https://cdn.example/img.jpg");
  });

  it("skips non-importable image URLs", () => {
    expect(extractFirstImageUrl("![x](http://cdn.example/a.jpg)")).toBeNull();
    expect(extractFirstImageUrl("![x](https://127.0.0.1/a.jpg)")).toBeNull();
    expect(extractFirstImageUrl("no images here")).toBeNull();
  });
});

describe("clampOriginalDate", () => {
  const now = new Date("2026-07-28T00:00:00Z");
  it("passes an honest past date through", () => {
    const d = new Date("2024-05-01T00:00:00Z");
    expect(clampOriginalDate(d, now)).toEqual(d);
  });
  it("clamps future dates to now (no future-sorting TIDs)", () => {
    expect(clampOriginalDate(new Date("2030-01-01"), now)).toEqual(now);
  });
  it("rejects pre-epoch garbage and invalid dates", () => {
    expect(clampOriginalDate(new Date("1932-01-01"), now)).toBeNull();
    expect(clampOriginalDate(new Date("nope"), now)).toBeNull();
    expect(clampOriginalDate(null, now)).toBeNull();
  });
});

describe("fetchCoverCandidate", () => {
  const allow = (m: string | null) => m === "image/jpeg";

  it("returns bytes+mime for an allowed raster under the cap", async () => {
    const impl = fakeFetch({
      "https://cdn.example/a.jpg": () =>
        new Response(new Uint8Array(10), {
          headers: { "content-type": "image/jpeg" },
        }),
    });
    const got = await fetchCoverCandidate(
      "https://cdn.example/a.jpg",
      100,
      allow,
      impl,
    );
    expect(got?.mime).toBe("image/jpeg");
    expect(got?.bytes.byteLength).toBe(10);
  });

  it("returns null on wrong mime, oversize, non-ok, or refused URL", async () => {
    const impl = fakeFetch({
      "https://cdn.example/a.svg": () =>
        new Response("x", { headers: { "content-type": "image/svg+xml" } }),
      "https://cdn.example/big.jpg": () =>
        new Response(new Uint8Array(200), {
          headers: { "content-type": "image/jpeg" },
        }),
      "https://cdn.example/404.jpg": () => new Response(null, { status: 404 }),
    });
    expect(
      await fetchCoverCandidate("https://cdn.example/a.svg", 100, allow, impl),
    ).toBeNull();
    expect(
      await fetchCoverCandidate(
        "https://cdn.example/big.jpg",
        100,
        allow,
        impl,
      ),
    ).toBeNull();
    expect(
      await fetchCoverCandidate(
        "https://cdn.example/404.jpg",
        100,
        allow,
        impl,
      ),
    ).toBeNull();
    expect(
      await fetchCoverCandidate("https://127.0.0.1/a.jpg", 100, allow, impl),
    ).toBeNull();
  });
});

describe("isCrossSite", () => {
  it("same-origin and absent Origin pass; foreign Origin fails", () => {
    const url = "https://app.example/api/import";
    expect(
      isCrossSite(
        new Request(url, {
          method: "POST",
          headers: { origin: "https://app.example" },
        }),
      ),
    ).toBe(false);
    expect(isCrossSite(new Request(url, { method: "POST" }))).toBe(false);
    expect(
      isCrossSite(
        new Request(url, {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toBe(true);
  });
});
