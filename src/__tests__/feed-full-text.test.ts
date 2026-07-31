// @vitest-environment node
import { describe, expect, it } from "vitest";

import { rssFeedXml } from "~/lib/feed";
import {
  MARKDOWN_PARSE_BUDGET_CHARS,
  markdownBudget,
  markdownToHtml,
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

/**
 * The parse-side bound — the one the old test above was mistakenly credited
 * with. What matters is how much markdown is HANDED TO the parser across one
 * request, because that is the CPU cost and it is paid before any output exists
 * to measure. A Workers free-tier invocation gets 10 ms; a 50-record feed page
 * of full-text rendering measures ~3 s.
 */
describe("markdownBudget — how much one request may parse", () => {
  it("renders while the budget covers the next document, then stops", () => {
    const budget = markdownBudget(1_000);
    expect(budget.render("word ".repeat(120))).toContain("<p>"); // 600 chars
    expect(budget.remaining).toBe(400);
    // 600 more would exceed 1,000 — refused whole rather than truncated.
    expect(budget.render("word ".repeat(120))).toBe("");
    expect(budget.remaining).toBe(400);
    // A shorter one still fits: the budget tracks characters, not calls.
    expect(budget.render("word ".repeat(20))).toContain("<p>");
  });

  it("refuses a document larger than the whole budget outright", () => {
    const budget = markdownBudget(1_000);
    // Never partially rendered: cutting markdown mid-document emits a dangling
    // emphasis run or half a code fence, and the parse is already paid.
    expect(budget.render("x".repeat(5_000))).toBe("");
    expect(budget.remaining).toBe(1_000);
  });

  it("bounds a full 50-record feed page to the budget, not 50× it", () => {
    const budget = markdownBudget(MARKDOWN_PARSE_BUDGET_CHARS);
    const post = "word ".repeat(4_000); // 20,000 chars, a realistic long essay
    const rendered = Array.from({ length: 50 }, () => budget.render(post));
    // The measured cost of doing this unbounded is ~3,000 ms of CPU against a
    // 10 ms limit — a 1102, not a slow feed.
    expect(budget.remaining).toBe(MARKDOWN_PARSE_BUDGET_CHARS);
    expect(rendered.every((html) => html === "")).toBe(true);
  });

  it("spends the budget on the items it is given first", () => {
    const budget = markdownBudget(6_000);
    const short = "word ".repeat(400); // 2,000 chars
    const first = budget.render(short);
    const second = budget.render(short);
    const third = budget.render(short);
    const fourth = budget.render(short);
    // Three fit, the fourth doesn't. The route sorts newest-first before
    // spending, so "first" means the posts a reader actually sees.
    expect([first, second, third].every((h) => h.includes("<p>"))).toBe(true);
    expect(fourth).toBe("");
  });

  // Pinned in both directions, because the number is derived from a
  // measurement and a well-meaning "let's serve more" would silently
  // reintroduce a 1102. See the table on the constant.
  it("keeps the shipped budget where the measurement put it", () => {
    expect(MARKDOWN_PARSE_BUDGET_CHARS).toBe(2_000);
  });

  it("charges nothing for records with no text", () => {
    const budget = markdownBudget(1_000);
    expect(budget.render(undefined)).toBe("");
    expect(budget.render("")).toBe("");
    expect(budget.render("   ")).toBe("");
    expect(budget.remaining).toBe(1_000);
  });
});
