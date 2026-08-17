// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  documentBodyMarkdown,
  hasForeignContent,
  isMarkdownContent,
  MARKDOWN_CONTENT_TYPE,
  markdownContent,
} from "../lib/document-content";
import { plainTextBody as projectBody, stripMarkdown } from "../lib/feed";
import {
  buildDocumentRecord,
  MAX_BODY_LENGTH,
  updateDocumentRecord,
  writerDek,
} from "../lib/publish";
import { readFileSync } from "node:fs";

const input = {
  title: "Hello Atmosphere",
  body: "# Heading\n\nA paragraph with **bold** and a [link](https://example.com).\n\nSecond paragraph.",
  site: "https://goldroad.example",
  path: "/3abc2345678df",
};

/**
 * The schema on disk. Read as a file rather than imported so the assertions
 * below are about the published artifact — the thing other implementers fetch
 * — and not about a bundler's view of it.
 */
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../lexicons/pub/goldroad/content/markdown.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("the pub.goldroad.content.markdown schema (PERMANENT public API)", () => {
  it("declares the NSID the code writes — the two can never drift", () => {
    expect(schema.id).toBe(MARKDOWN_CONTENT_TYPE);
    expect(schema.id).toBe("pub.goldroad.content.markdown");
    expect(schema.lexicon).toBe(1);
  });

  it("is an object def with `markdown` required, and nothing speculative beside it", () => {
    expect(schema.defs.main.type).toBe("object");
    expect(schema.defs.main.required).toEqual(["markdown"]);
    // Every field name here is unrenameable. A new field is a deliberate,
    // additive act; this assertion is what makes an accidental one visible.
    expect(Object.keys(schema.defs.main.properties)).toEqual(["markdown"]);
    expect(schema.defs.main.properties.markdown.type).toBe("string");
  });

  it("bounds `markdown` no tighter than the publish path's own body cap", () => {
    const { maxLength, maxGraphemes } = schema.defs.main.properties.markdown;
    // The app validates body.length (UTF-16 code units) against MAX_BODY_LENGTH.
    // A grapheme is never fewer than one code unit, so the grapheme ceiling is
    // that same number; a code unit is never more than three UTF-8 bytes
    // (surrogate pairs are two units for four bytes), so the byte ceiling is
    // three times it. Both must be >= what we actually write, or the schema
    // would forbid records the app happily produces.
    expect(maxGraphemes).toBe(MAX_BODY_LENGTH);
    expect(maxLength).toBe(MAX_BODY_LENGTH * 3);
  });

  it("has an NSID whose authority is a domain we can actually hold", () => {
    // Authority = segments reversed minus the final name segment, so this is
    // `content.goldroad.pub` with the name `markdown` — the same shape as
    // app.bsky.feed.post resolving to feed.bsky.app. Asserted because getting
    // it wrong is unfixable after the first write.
    const segments = schema.id.split(".");
    const authority = segments.slice(0, -1).reverse().join(".");
    const name = segments.at(-1);
    expect(authority).toBe("content.goldroad.pub");
    expect(name).toBe("markdown");
    // NSID name grammar: letters and digits only, no hyphens, no leading digit.
    expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
  });
});

describe("emission: the body is written as both formats", () => {
  it("puts the markdown in the content union and its projection in textContent", () => {
    const record = buildDocumentRecord(input);
    expect(record.content).toEqual({
      $type: "pub.goldroad.content.markdown",
      markdown: input.body,
    });
    // textContent is what the lexicon says it is: no markdown syntax left.
    expect(record.textContent).toBe(
      "Heading\n\nA paragraph with bold and a link.\n\nSecond paragraph.",
    );
    expect(record.textContent).not.toContain("**");
    expect(record.textContent).not.toContain("](");
    expect(record.textContent).not.toContain("#");
  });

  it("keeps the union and the projection in step across an edit", () => {
    const published = buildDocumentRecord(input);
    const edited = updateDocumentRecord(published, {
      title: input.title,
      body: "Rewritten with *emphasis*.",
    });
    expect(edited.content?.markdown).toBe("Rewritten with *emphasis*.");
    expect(edited.textContent).toBe("Rewritten with emphasis.");
  });
});

describe("editability: ours is editable, foreign is not (step-zero fix)", () => {
  const existing = {
    $type: "site.standard.document",
    title: "Old title",
    site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
    path: "/3abc2345678df",
    publishedAt: "2026-07-01T00:00:00.000Z",
  };

  it("edits a document carrying OUR union", () => {
    // Written as a literal, not via markdownContent(), so this test states the
    // wire shape it depends on rather than trusting a helper to agree with it.
    const ours = {
      ...existing,
      content: {
        $type: "pub.goldroad.content.markdown",
        markdown: "The **original** body.",
      },
      textContent: "The original body.",
    };
    const record = updateDocumentRecord(ours, {
      title: "New title",
      body: "The **edited** body.",
    });
    expect(record.content?.markdown).toBe("The **edited** body.");
    expect(record.textContent).toBe("The edited body.");
  });

  it("still refuses a foreign union", () => {
    expect(() =>
      updateDocumentRecord(
        { ...existing, content: { $type: "pub.leaflet.content", blocks: [] } },
        { title: "t", body: "b" },
      ),
    ).toThrow("foreign content");
  });

  it("treats a malformed claim on our own type as foreign", () => {
    // Our $type with no markdown string is not something we can render, so
    // editing it would publish over a body we never actually read.
    for (const content of [
      { $type: MARKDOWN_CONTENT_TYPE },
      { $type: MARKDOWN_CONTENT_TYPE, markdown: 42 },
      { $type: MARKDOWN_CONTENT_TYPE, markdown: null },
    ]) {
      expect(hasForeignContent({ content })).toBe(true);
      expect(isMarkdownContent(content)).toBe(false);
      expect(() =>
        updateDocumentRecord(
          { ...existing, content },
          { title: "t", body: "b" },
        ),
      ).toThrow("foreign content");
    }
  });

  it("leaves a union-less document editable, as it has always been", () => {
    expect(hasForeignContent({})).toBe(false);
    expect(hasForeignContent({ content: null })).toBe(false);
    expect(hasForeignContent({ content: undefined })).toBe(false);
    expect(hasForeignContent({ content: markdownContent("x") })).toBe(false);
  });
});

describe("the compatibility triangle: three generations of record", () => {
  it("post-mint records read from the union", () => {
    expect(
      documentBodyMarkdown({
        content: markdownContent("From the **union**."),
        textContent: "From the union.",
      }),
    ).toBe("From the **union**.");
  });

  it("pre-mint records read from textContent, which is markdown there", () => {
    // The case that must not regress: every post published before this change
    // stored markdown in textContent, and it still has to reach the markdown
    // renderer verbatim. These records are not migrated in bulk.
    expect(
      documentBodyMarkdown({ textContent: "Old post with **bold**." }),
    ).toBe("Old post with **bold**.");
  });

  it("foreign-union records read from textContent too", () => {
    expect(
      documentBodyMarkdown({
        content: { $type: "pub.leaflet.content" },
        textContent: "Leaflet's plaintext.",
      }),
    ).toBe("Leaflet's plaintext.");
  });

  it("survives records with nothing usable in either field", () => {
    expect(documentBodyMarkdown({})).toBe("");
    expect(documentBodyMarkdown({ textContent: 42 })).toBe("");
    expect(documentBodyMarkdown({ content: "not an object" })).toBe("");
    expect(documentBodyMarkdown({ content: null, textContent: null })).toBe("");
  });

  it("round-trips a post through publish → reopen with formatting intact", () => {
    const published = buildDocumentRecord(input);
    // What /write hands the editor when the writer reopens the post. Reading
    // textContent here instead would silently flatten their formatting.
    expect(documentBodyMarkdown(published)).toBe(input.body);
    // And the subtitle field stays empty, because that description is still
    // just the generated excerpt — compared against the MARKDOWN body.
    expect(writerDek(published)).toBe("");
  });

  it("keeps a hand-written subtitle recognisable on a post-mint record", () => {
    const published = buildDocumentRecord({ ...input, dek: "A real subtitle" });
    expect(writerDek(published)).toBe("A real subtitle");
  });
});

describe("plainTextBody: the projection written into textContent", () => {
  /** The bound the publish path passes, so these read like production calls. */
  const plainTextBody = (markdown: string) =>
    projectBody(markdown, MAX_BODY_LENGTH);

  it("keeps paragraph structure, unlike the excerpt strip", () => {
    const body = "First para.\n\nSecond para.\n\nThird para.";
    expect(plainTextBody(body)).toBe(body);
    // The excerpt strip collapses everything — correct for a 300-char summary,
    // wrong for a whole document, which is why these are two functions.
    expect(stripMarkdown(body)).toBe("First para. Second para. Third para.");
  });

  it("strips the markdown constructs a plaintext field must not contain", () => {
    expect(plainTextBody("## A heading")).toBe("A heading");
    expect(plainTextBody("- one\n- two")).toBe("one\ntwo");
    expect(plainTextBody("> quoted")).toBe("quoted");
    expect(plainTextBody("*em* and __strong__ and ~~gone~~")).toBe(
      "em and strong and gone",
    );
    expect(plainTextBody("![alt text](https://example.com/a.png)")).toBe(
      "alt text",
    );
    expect(plainTextBody("`inline code`")).toBe("inline code");
  });

  it("keeps fenced code as text, dropping only the fences", () => {
    // The excerpt strip throws code away on purpose; a plaintext rendition of
    // the document cannot, or a technical post loses whole sections from the
    // field that non-Goldroad readers fall back to.
    const body = "Before.\n\n```js\nconst x = 1;\n```\n\nAfter.";
    const plain = plainTextBody(body);
    expect(plain).toContain("const x = 1;");
    expect(plain).not.toContain("```");
    expect(plain).toBe("Before.\n\nconst x = 1;\n\nAfter.");
    expect(stripMarkdown(body)).toBe("Before. After.");
  });

  it("collapses runaway whitespace without collapsing paragraphs", () => {
    expect(plainTextBody("a   \t b\n\n\n\n\nc  \n  d")).toBe("a b\n\nc\nd");
    expect(plainTextBody("   \n\n  padded  \n\n   ")).toBe("padded");
  });

  it("returns empty for a body that projects to nothing", () => {
    // An un-alt-texted image is a real body with no plaintext at all; the
    // record omits textContent rather than storing "".
    expect(plainTextBody("![](/img/did/cid)")).toBe("");
    expect(
      buildDocumentRecord({ ...input, body: "![](/img/did/cid)" }).textContent,
    ).toBeUndefined();
  });

  it("bounds its scan window to the caller's explicit limit", () => {
    const huge = "word ".repeat(2000);
    expect(projectBody(huge, 100).length).toBeLessThanOrEqual(100);
    // The publish path passes the bound the body was already validated
    // against, so a legal body is never truncated by the projection.
    expect(plainTextBody("x".repeat(MAX_BODY_LENGTH))).toHaveLength(
      MAX_BODY_LENGTH,
    );
  });
});
