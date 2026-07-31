// @vitest-environment node
import { describe, expect, it } from "vitest";

import { rssFeedXml } from "~/lib/feed";
import { markdownToHtml } from "~/lib/markdown-html";

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
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://example.com">a link</a>');
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<blockquote>");
  });

  it("renders GFM, because the reader page does", () => {
    // The feed and the page share a plugin list on purpose; a table that works
    // on one and not the other is the drift this guards.
    expect(markdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |\n")).toContain(
      "<table>",
    );
  });

  it("drops raw HTML rather than passing it through", () => {
    // Same call the reader makes by refusing rehype-raw. The markdown came off
    // a stranger's PDS; a <script> in a post body must never reach a feed
    // reader as markup.
    const html = markdownToHtml(
      "Before\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nAfter",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
    expect(html).toContain("Before");
    expect(html).toContain("After");
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

  it("bounds a hostile record without bounding a real essay", () => {
    // A 10,000-word post renders well under the cap; the cap exists for the
    // record that carries a megabyte of one repeated character.
    const essay = "word ".repeat(10_000);
    expect(rssFeedXml(channel, [item(`<p>${essay}</p>`)])).toContain(
      essay.trim(),
    );

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
