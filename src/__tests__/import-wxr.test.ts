import { describe, expect, it } from "vitest";

/**
 * WordPress WXR export XML parsing (jsdom's DOMParser — this test file runs
 * under the default jsdom environment, unlike the fflate-based parsers).
 * Pins the field-name contract (wp:post_id, wp:post_type, wp:status,
 * content:encoded) against WordPress core's own exporter shape, the
 * post/page/attachment filter, and the DOCTYPE refusal that closes the
 * entity-bomb class of attack independent of the parser's own behavior.
 */
import { parseWxrExport, wordpressPostGuid } from "../lib/import-wxr";

const LONG_HTML = `<h2>A real post</h2>${`<p>${"substantial words ".repeat(40)}</p>`.repeat(3)}`;
const STUB_HTML = `<p>Short stub.</p>`;

function item(fields: {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  date?: string;
  html?: string;
  link?: string;
}): string {
  return `<item>
    <title>${fields.title ?? "Untitled"}</title>
    <link>${fields.link ?? `https://blog.example.com/${fields.id}/`}</link>
    <wp:post_id>${fields.id}</wp:post_id>
    <wp:post_type>${fields.type ?? "post"}</wp:post_type>
    <wp:status>${fields.status ?? "publish"}</wp:status>
    <wp:post_date>${fields.date ?? "2024-03-01 10:00:00"}</wp:post_date>
    <content:encoded><![CDATA[${fields.html ?? LONG_HTML}]]></content:encoded>
  </item>`;
}

function wxr(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>My Blog</title>
    ${items.join("\n")}
  </channel>
</rss>`;
}

describe("parseWxrExport — happy path", () => {
  it("reads posts with the WordPress-namespaced fields", () => {
    const parsed = parseWxrExport(
      wxr([item({ id: "1", title: "First post" })]),
    );
    expect(parsed.malformed).toBe(false);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].id).toBe("1");
    expect(parsed.posts[0].title).toBe("First post");
    expect(parsed.posts[0].publishedAtSource).toBe(true);
    expect(parsed.posts[0].contentHtml).toContain("substantial words");
    expect(parsed.posts[0].link).toBe("https://blog.example.com/1/");
  });

  it("newest first", () => {
    const parsed = parseWxrExport(
      wxr([
        item({ id: "old", date: "2024-01-01 00:00:00" }),
        item({ id: "new", date: "2024-06-01 00:00:00" }),
      ]),
    );
    expect(parsed.posts.map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("drops an unsafe (non-https) link rather than storing it", () => {
    const parsed = parseWxrExport(
      wxr([item({ id: "1", link: "http://blog.example.com/1/" })]),
    );
    expect(parsed.posts[0].link).toBeNull();
  });
});

describe("parseWxrExport — per-item honesty", () => {
  it("filters to posts, counting pages and attachments as skipped", () => {
    const parsed = parseWxrExport(
      wxr([
        item({ id: "1", type: "post" }),
        item({ id: "2", type: "page" }),
        item({ id: "3", type: "attachment" }),
        item({ id: "4", type: "nav_menu_item" }),
      ]),
    );
    expect(parsed.posts.map((p) => p.id)).toEqual(["1"]);
    expect(parsed.skipped).toEqual({ pages: 1, attachments: 1, other: 1 });
  });

  it("draft/non-publish status is reported, never treated as published", () => {
    const parsed = parseWxrExport(wxr([item({ id: "1", status: "draft" })]));
    expect(parsed.posts[0].publishedAtSource).toBe(false);
  });

  it("flags teaser-length html as a possible stub", () => {
    const parsed = parseWxrExport(
      wxr([
        item({ id: "1", html: STUB_HTML }),
        item({ id: "2", html: LONG_HTML }),
      ]),
    );
    expect(parsed.posts.find((p) => p.id === "1")?.preview).toBe(true);
    expect(parsed.posts.find((p) => p.id === "2")?.preview).toBe(false);
  });
});

describe("parseWxrExport — defensive paths", () => {
  it("refuses any DOCTYPE/ENTITY-bearing input before it ever reaches DOMParser", () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE rss [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<rss><channel>${item({ id: "1" })}</channel></rss>`;
    const parsed = parseWxrExport(bomb);
    expect(parsed.malformed).toBe(true);
    expect(parsed.posts).toEqual([]);
  });

  it("malformed XML is reported, never throws", () => {
    expect(parseWxrExport("<rss><channel><item>").malformed).toBe(true);
  });

  it("valid XML with no rss/channel root is reported as malformed", () => {
    expect(parseWxrExport("<not-a-feed/>").malformed).toBe(true);
  });

  it("a feed root with zero items is a valid, empty export — not malformed", () => {
    const parsed = parseWxrExport(
      `<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>`,
    );
    expect(parsed.malformed).toBe(false);
    expect(parsed.posts).toEqual([]);
  });

  it("caps at MAX_EXPORT_POSTS and reports the rest as truncated", async () => {
    const { MAX_EXPORT_POSTS } = await import("../lib/import");
    const items = Array.from({ length: MAX_EXPORT_POSTS + 4 }, (_, i) =>
      item({ id: `${i}` }),
    );
    const parsed = parseWxrExport(wxr(items));
    expect(parsed.posts).toHaveLength(MAX_EXPORT_POSTS);
    expect(parsed.truncated).toBe(4);
    // Building and XML-parsing 1004 full items is inherent to the cap being
    // tested, not overhead to optimise away. It costs ~1.3s idle and several
    // times that on a busy box, so the 5s default leaves too little headroom.
  }, 30_000);
});

describe("identity helper", () => {
  it("namespaces export guids so re-uploads dedupe and other sources can't collide", () => {
    expect(wordpressPostGuid("1")).toBe("wordpress-export:1");
  });
});
