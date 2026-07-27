// @vitest-environment node
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  escapeXml,
  plainTextExcerpt,
  rfc822Date,
  rssFeedXml,
} from "../lib/feed";

/** Real XML parser (jsdom's, saxes-backed) — feed assertions parse the
 * document back instead of trusting string containment alone. */
function parseXml(xml: string): Document {
  const { DOMParser } = new JSDOM("").window;
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return doc as unknown as Document;
}

describe("escapeXml — hostile third-party strings", () => {
  it("escapes all five XML metacharacters", () => {
    expect(escapeXml(`<script>alert("x&y")</script>'`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&apos;",
    );
  });

  it("neutralizes ]]> (no CDATA breakout possible)", () => {
    expect(escapeXml("]]>")).toBe("]]&gt;");
    expect(escapeXml("]]>")).not.toContain("]]>");
  });

  it("double-escapes pre-encoded entities (never trusts input encoding)", () => {
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("drops XML-illegal control characters but keeps tab/LF/CR", () => {
    expect(escapeXml("a\u0000b\u000bc\u000ed\u001fe\u007ff\u009fg")).toBe(
      "abcdefg",
    );
    expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("preserves emoji and astral-plane pairs", () => {
    expect(escapeXml("fire 🔥 and flags 🏴‍☠️")).toBe("fire 🔥 and flags 🏴‍☠️");
  });

  it("replaces lone surrogates (unserializable) with U+FFFD", () => {
    expect(escapeXml("bad\ud800end")).toBe("bad\ufffdend");
    expect(escapeXml("bad\udfffend")).toBe("bad\ufffdend");
    // A well-formed pair is NOT touched.
    expect(escapeXml("😀")).toBe("😀");
  });

  it("drops U+FFFE/U+FFFF noncharacters", () => {
    expect(escapeXml("a\ufffeb\uffffc")).toBe("abc");
  });
});

describe("plainTextExcerpt", () => {
  it("strips common markdown down to plain text", () => {
    const md = [
      "# Heading",
      "",
      "Some **bold** and _italic_ text with a [link](https://example.com)",
      "and an image ![alt text](https://example.com/i.png).",
      "",
      "> a quote",
      "",
      "- item one",
      "1. item two",
      "",
      "`inline code` and:",
      "",
      "```js",
      "const secret = 'never shown';",
      "```",
    ].join("\n");
    const out = plainTextExcerpt(md);
    expect(out).toBe(
      "Heading Some bold and italic text with a link and an image alt text. a quote item one item two inline code and:",
    );
  });

  it("returns short text unchanged (no ellipsis)", () => {
    expect(plainTextExcerpt("Just a sentence.")).toBe("Just a sentence.");
  });

  it("truncates near the cap on a word boundary with an ellipsis", () => {
    const long = "word ".repeat(200).trim();
    const out = plainTextExcerpt(long);
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith("…")).toBe(true);
    // Word-boundary cut: never ends mid-"word".
    expect(out).toMatch(/word…$/);
  });

  it("stays cheap and bounded on hostile degenerate markdown (no quadratic scan)", () => {
    // Unmatched-bracket floods made the original link/image patterns
    // quadratic (seconds of CPU on a ~10 ms budget). The scan window +
    // fail-fast bracket classes must keep this trivial.
    const hostiles = [
      "[".repeat(100_000),
      "[a](b".repeat(20_000),
      "![".repeat(50_000),
      "`".repeat(100_000),
    ];
    for (const hostile of hostiles) {
      const start = performance.now();
      const out = plainTextExcerpt(hostile);
      // Generous CI headroom — a quadratic regression costs seconds, not ms.
      expect(performance.now() - start).toBeLessThan(250);
      expect(out.length).toBeLessThanOrEqual(301);
    }
  });
});

describe("rfc822Date", () => {
  it("formats an ISO timestamp as an RFC 822 UTC date", () => {
    expect(rfc822Date("2026-07-20T12:30:00Z")).toBe(
      "Mon, 20 Jul 2026 12:30:00 GMT",
    );
  });

  it("is null for garbage and non-strings", () => {
    expect(rfc822Date("not a date")).toBeNull();
    expect(rfc822Date(undefined)).toBeNull();
    expect(rfc822Date(1234567890)).toBeNull();
  });
});

describe("rssFeedXml — parse-back with a real XML parser", () => {
  const hostileTitle = `Attack ]]><script>alert("pwn")</script> & <img src=x>`;
  const channel = {
    title: hostileTitle,
    link: "https://trygoldroad.com/@writer.example",
    selfUrl: "https://trygoldroad.com/@writer.example/rss.xml",
    description: `"Quotes" & <angles>`,
  };
  const items = [
    {
      title: hostileTitle,
      link: "https://trygoldroad.com/@writer.example/3aaa",
      guid: "at://did:plc:fake2222222222writer2222/site.standard.document/3aaa",
      pubDate: "Mon, 20 Jul 2026 12:30:00 GMT",
      description: "An excerpt with ]]> inside & <b>markup</b>",
    },
    {
      title: "Plain",
      link: "https://trygoldroad.com/@writer.example/3bbb",
      guid: "at://did:plc:fake2222222222writer2222/site.standard.document/3bbb",
      pubDate: null,
      description: null,
    },
  ];

  it("produces well-formed XML that round-trips hostile values as text", () => {
    const xml = rssFeedXml(channel, items);
    // Nothing hostile survives unescaped in the serialized document.
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("]]>");

    const doc = parseXml(xml);
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.tagName).toBe("rss");
    expect(doc.documentElement.getAttribute("version")).toBe("2.0");

    // The hostile title parses back to EXACTLY the original string — inert
    // text, not markup.
    expect(doc.querySelector("channel > title")?.textContent).toBe(
      hostileTitle,
    );
    const itemEls = doc.querySelectorAll("item");
    expect(itemEls).toHaveLength(2);
    expect(itemEls[0].querySelector("title")?.textContent).toBe(hostileTitle);
    expect(itemEls[0].querySelector("description")?.textContent).toBe(
      items[0].description,
    );
  });

  it("emits the atom:link self reference", () => {
    const doc = parseXml(rssFeedXml(channel, items));
    const self = doc.getElementsByTagNameNS(
      "http://www.w3.org/2005/Atom",
      "link",
    )[0];
    expect(self?.getAttribute("href")).toBe(channel.selfUrl);
    expect(self?.getAttribute("rel")).toBe("self");
    expect(self?.getAttribute("type")).toBe("application/rss+xml");
  });

  it("clamps oversized third-party values at the serialization choke point", () => {
    const xml = rssFeedXml({ ...channel, description: "d".repeat(100_000) }, [
      { ...items[1], title: "t".repeat(100_000) },
    ]);
    const doc = parseXml(xml);
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(
      doc.querySelector("channel > description")?.textContent?.length,
    ).toBe(2048);
    expect(doc.querySelector("item > title")?.textContent?.length).toBe(2048);
  });

  it("emits guid with isPermaLink=false and omits absent pubDate/description", () => {
    const doc = parseXml(rssFeedXml(channel, items));
    const [first, second] = Array.from(doc.querySelectorAll("item"));
    expect(first.querySelector("guid")?.getAttribute("isPermaLink")).toBe(
      "false",
    );
    expect(first.querySelector("guid")?.textContent).toBe(items[0].guid);
    expect(first.querySelector("pubDate")?.textContent).toBe(items[0].pubDate);
    expect(second.querySelector("pubDate")).toBeNull();
    expect(second.querySelector("description")).toBeNull();
  });
});
