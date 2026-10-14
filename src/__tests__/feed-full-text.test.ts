// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { rssFeedXml } from "~/lib/feed";
import {
  FEED_RENDER_BUDGET_CHARS,
  markdownToHtml,
  RENDER_VERSION,
  renderBodies,
  renderBudget,
} from "~/lib/markdown-html";

const channel = {
  title: "A publication",
  link: "https://trygoldroad.com/@writer.example",
  selfUrl: "https://trygoldroad.com/@writer.example/rss.xml",
  description: "Posts by writer.example",
};

const item = (content: string | null) => ({
  title: "The morning the presses stopped",
  link: "https://trygoldroad.com/@writer.example/3lyk73wxnok2f",
  guid: "at://did:plc:abc/site.standard.document/3lyk73wxnok2f",
  content,
});

describe("markdownToHtml — the same rendering the page does", () => {
  it("renders the block and inline shapes the round-trip pins", () => {
    const html = markdownToHtml(
      "# Title\n\nBody with **bold**, *italic* and [a link](https://example.com).\n\n- one\n- two\n\n> Quoted\n",
    );
    expect(html).toMatch(/<h2 class="[^"]*">Title<\/h2>/);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toMatch(/<a href="https:\/\/example.com"[^>]*>a link<\/a>/);
    expect(html).toMatch(/<li[^>]*>one<\/li>/);
    expect(html).toContain("<blockquote");
  });

  it("renders GFM, because the reader page does", () => {
    expect(markdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |\n")).toContain(
      "<table",
    );
  });

  it("escapes raw HTML into text rather than passing it through", () => {
    // The markdown came off a stranger's PDS; a <script> in a post body must
    // never reach a page or a feed reader as markup.
    const html = markdownToHtml(
      "Before\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nAfter",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Before");
    expect(html).toContain("After");
  });

  it("refuses unsafe link and image URLs, however they're spelled", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java&#115;cript:alert(1)",
      "<java\tscript:alert(1)>",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:image/png;base64,AAAA",
      "intent://x#Intent;end",
      "ms-msdt:/id",
      "tel:123",
    ]) {
      const html = markdownToHtml(`[a](${url}) ![b](${url}) <${url}>`);
      expect(html).not.toMatch(/(href|src)="(?!#)/);
    }
  });

  it("keeps safe links and images, and marks writer links nofollow", () => {
    const html = markdownToHtml(
      "[a](https://x.example) [m](mailto:a@x.example) [r](/@writer/3abc) ![i](/img/did/cid)",
    );
    expect(html).toContain('href="https://x.example"');
    expect(html).toContain('href="mailto:a@x.example"');
    expect(html).toContain('href="/@writer/3abc"');
    expect(html).toContain('src="/img/did/cid"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
  });

  it("keeps the text of a link it won't follow", () => {
    const html = markdownToHtml("[click me](javascript:alert(1))");
    expect(html).toMatch(/<a [^>]*>click me<\/a>/);
    expect(html).not.toContain("href");
    expect(html).not.toContain("javascript");
  });

  it("falls back to plain paragraphs for input markdown-it is slow on", () => {
    for (const hostile of ["[".repeat(50_000), `${"word ".repeat(25_000)}*`]) {
      const start = performance.now();
      const html = markdownToHtml(hostile);
      expect(performance.now() - start).toBeLessThan(100);
      expect(html.startsWith("<p")).toBe(true);
    }
    expect(markdownToHtml("a\n\n<b>&</b>")).toContain("&lt;b&gt;&amp;");
  });

  it("renders GFM task lists as disabled checkboxes", () => {
    const html = markdownToHtml("- [ ] todo\n- [x] done");
    expect(html).toContain('<input type="checkbox" disabled> todo');
    expect(html).toContain('<input type="checkbox" disabled checked> done');
  });

  it("escapes a fence's language into its class", () => {
    const html = markdownToHtml('```js"><script>\nx\n```');
    expect(html).not.toContain("<script");
  });

  it("treats absent, blank and non-string content as no content", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      expect(markdownToHtml(value)).toBe("");
    }
  });
});

describe("content:encoded in the feed", () => {
  it("declares the namespace it uses", () => {
    expect(rssFeedXml(channel, [item("<p>Body</p>")])).toContain(
      'xmlns:content="http://purl.org/rss/1.0/modules/content/"',
    );
  });

  it("escapes the HTML rather than wrapping it in CDATA", () => {
    // Entity-escaping is the rule for every value in this serializer, and it
    // is what keeps the payload inert on the way through: no `]]>` to get
    // wrong, and a parser that doesn't understand the module sees only text.
    const xml = rssFeedXml(channel, [item("<p>Body &amp; more</p>")]);
    expect(xml).toContain(
      "<content:encoded>&lt;p&gt;Body &amp;amp; more&lt;/p&gt;</content:encoded>",
    );
    expect(xml).not.toContain("CDATA");
  });

  it("omits the element entirely when there is no content", () => {
    for (const value of [null, "", undefined]) {
      expect(rssFeedXml(channel, [item(value ?? null)])).not.toContain(
        "content:encoded",
      );
    }
  });

  // This used to be named for bounding hostile input while asserting only that
  // the OUTPUT serializer truncates. `item()` takes already-rendered HTML, so
  // the step that actually had no bound — the markdown parse — was never
  // exercised, and the suite read as though it were covered. The parse is what
  // costs CPU, and it is paid before any output can be measured.
  it("bounds the serialized output of a hostile record", () => {
    const huge = "x".repeat(300_000);
    const xml = rssFeedXml(channel, [item(huge)]);
    expect(xml).toContain("content:encoded");
    expect(xml.length).toBeLessThan(300_000);
  });

  it("still carries the short description alongside the full text", () => {
    // content:encoded joins description, it doesn't replace it: readers that
    // show a preview list need something short to show.
    const xml = rssFeedXml(channel, [
      { ...item("<p>The whole piece</p>"), description: "A summary" },
    ]);
    expect(xml).toContain("<description>A summary</description>");
    expect(xml).toContain("The whole piece");
  });
});

/** An in-memory stand-in for `caches.default`. */
function fakeCache() {
  const store = new Map<string, string>();
  const cache = {
    match: vi.fn(async (key: string) =>
      store.has(key) ? new Response(store.get(key)) : undefined,
    ),
    put: vi.fn(async (key: string, response: Response) => {
      store.set(key, await response.text());
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { cache, store };
}

describe("renderBodies — a body renders once, then comes from the cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves a second request for the same markdown from the cache", async () => {
    const { cache, store } = fakeCache();
    const [first] = await renderBodies(["Some **bold**."]);
    expect(first).toContain("<strong>bold</strong>");
    expect(cache.put).toHaveBeenCalledTimes(1);
    // Overwrite the stored entry: getting it back proves the second answer
    // came from the cache, not a fresh render.
    const [key] = [...store.keys()];
    store.set(key, "<p>cached</p>");
    expect(await renderBodies(["Some **bold**."])).toEqual(["<p>cached</p>"]);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("keys by the markdown itself, so different bodies never share", async () => {
    fakeCache();
    await renderBodies(["Mine."]);
    expect(await renderBodies(["Theirs."])).toEqual([
      expect.stringContaining("Theirs."),
    ]);
  });

  it("renders anyway when the cache itself fails", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => {
          throw new Error("cache down");
        },
        put: async () => {
          throw new Error("cache down");
        },
      },
    });
    expect(await renderBodies(["Body."])).toEqual([
      expect.stringContaining("Body."),
    ]);
  });

  it("returns '' for a miss the caller declines, and caches nothing", async () => {
    const { cache } = fakeCache();
    expect(await renderBodies(["Body."], () => false)).toEqual([""]);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("spends the budget on misses in the order given, and skips empty bodies", async () => {
    const { store } = fakeCache();
    await renderBodies(["Older, already cached."]);
    const asked: string[] = [];
    const html = await renderBodies(
      ["", "Newest.", "Older, already cached.", "Oldest."],
      (markdown) => {
        asked.push(markdown);
        return asked.length === 1;
      },
    );
    // Only misses with text reach the budget, newest first.
    expect(asked).toEqual(["Newest.", "Oldest."]);
    expect(html[0]).toBe("");
    expect(html[1]).toContain("Newest.");
    expect(html[2]).toContain("Older, already cached.");
    expect(html[3]).toBe("");
    expect(store.size).toBe(2);
  });
});

/** Any change to the output must bump RENDER_VERSION, or 30-day-old cached
 * renders keep serving the previous markup. Update both together. */
it("pins the renderer's output to RENDER_VERSION", async () => {
  const fixture =
    "# H\n\n*a* **b** ~~c~~ `d` [e](https://e.example) ![f](/img/x/y)\n\n- [x] g\n\n> h\n\n```js\ni\n```\n\n| j | k |\n| - | -: |\n| 1 | 2 |\n\nl[^1]\n\n[^1]: m";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(markdownToHtml(fixture)),
  );
  const hash = Buffer.from(digest).toString("hex").slice(0, 16);
  expect({ RENDER_VERSION, hash }).toEqual({
    RENDER_VERSION: 1,
    hash: "2aa45ce6a1269f0c",
  });
});

describe("renderBudget — how much one feed request renders on cache misses", () => {
  it("always renders the first post, however long", () => {
    const mayRender = renderBudget(1_000);
    expect(mayRender("x".repeat(30_000))).toBe(true);
    expect(mayRender("x")).toBe(false);
  });

  it("then renders while the budget covers the next post", () => {
    const mayRender = renderBudget(1_000);
    expect(mayRender("x".repeat(600))).toBe(true);
    expect(mayRender("x".repeat(600))).toBe(false);
    // A shorter one still fits: the budget counts characters, not calls.
    expect(mayRender("x".repeat(300))).toBe(true);
  });

  it("covers a typical feed page of full posts", () => {
    // Five 3,000-character posts: the newest feed items a reader opens first.
    const mayRender = renderBudget();
    const post = "x".repeat(3_000);
    expect(Array.from({ length: 5 }, () => mayRender(post))).toEqual(
      Array(5).fill(true),
    );
    expect(FEED_RENDER_BUDGET_CHARS).toBe(15_000);
  });
});
