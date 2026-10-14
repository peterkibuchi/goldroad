// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  documentBodyMarkdown,
  hasForeignContent,
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
import { expectLinear, LINEAR_TEST_TIMEOUT_MS } from "./linear-time";

const input = {
  title: "Hello Atmosphere",
  body: "# Heading\n\nA paragraph with **bold** and a [link](https://example.com).\n\nSecond paragraph.",
  site: "https://goldroad.example",
  path: "/3abc2345678df",
};

describe("the at.markpub.markdown wire shape", () => {
  it("nests the markdown under `text`, per the markpub lexicons", () => {
    // Literal, not via markdownContent(): this pins the shape other apps read.
    expect(buildDocumentRecord(input).content).toEqual({
      $type: "at.markpub.markdown",
      text: { $type: "at.markpub.text", markdown: input.body },
      flavor: "gfm",
    });
    expect(MARKDOWN_CONTENT_TYPE).toBe("at.markpub.markdown");
  });
});

describe("emission: the body is written as both formats", () => {
  it("puts the markdown in the content union and its projection in textContent", () => {
    const record = buildDocumentRecord(input);
    expect(record.content?.text.markdown).toBe(input.body);
    // textContent is what the lexicon says it is: no markdown syntax left —
    // and the link's destination survives in plain-text form rather than
    // being deleted along with its brackets.
    expect(record.textContent).toBe(
      "Heading\n\nA paragraph with bold and a link (https://example.com).\n\nSecond paragraph.",
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
    expect(edited.content?.text.markdown).toBe("Rewritten with *emphasis*.");
    expect(edited.textContent).toBe("Rewritten with emphasis.");
  });
});

describe("editability: markpub is editable, foreign is not", () => {
  const existing = {
    $type: "site.standard.document",
    title: "Old title",
    site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
    path: "/3abc2345678df",
    publishedAt: "2026-07-01T00:00:00.000Z",
  };

  it("edits a document carrying markpub markdown, whoever wrote it", () => {
    // Another app's record: commonmark, a renderer we don't use, and a
    // `text` without `$type`. Nothing here is lost by rewriting it.
    const theirs = {
      ...existing,
      content: {
        $type: "at.markpub.markdown",
        flavor: "commonmark",
        renderingRules: "markdown-it",
        extensions: [],
        text: { markdown: "The **original** body." },
      },
      textContent: "The original body.",
    };
    expect(hasForeignContent(theirs)).toBe(false);
    const record = updateDocumentRecord(theirs, {
      title: "New title",
      body: "The **edited** body.",
    });
    expect(record.content).toEqual(markdownContent("The **edited** body."));
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

  it("treats markpub it can't round-trip as foreign", () => {
    // Fields an edit would drop, no inline markdown at all, or a textBlob
    // (the inline markdown is then only a preview). Saving would publish over
    // something we never read.
    const blob = {
      $type: "blob",
      ref: { $link: "bafkreiexample" },
      mimeType: "text/markdown",
      size: 200_000,
    };
    const text = { markdown: "Body" };
    for (const content of [
      { $type: MARKDOWN_CONTENT_TYPE, text, frontMatter: [{ title: "x" }] },
      { $type: MARKDOWN_CONTENT_TYPE, text, extensions: ["LaTeX"] },
      { $type: MARKDOWN_CONTENT_TYPE, text: { ...text, facets: [{}] } },
      { $type: MARKDOWN_CONTENT_TYPE, text: { ...text, lenses: [{}] } },
      { $type: MARKDOWN_CONTENT_TYPE },
      { $type: MARKDOWN_CONTENT_TYPE, markdown: "flat, not under text" },
      { $type: MARKDOWN_CONTENT_TYPE, text: "a string" },
      { $type: MARKDOWN_CONTENT_TYPE, text: { markdown: 42 } },
      {
        $type: MARKDOWN_CONTENT_TYPE,
        text: { markdown: "Preview…", textBlob: blob },
      },
    ]) {
      expect(hasForeignContent({ content })).toBe(true);
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

describe("documentBodyMarkdown: where the body is read from", () => {
  it("markpub records read from the union", () => {
    expect(
      documentBodyMarkdown({
        content: markdownContent("From the **union**."),
        textContent: "From the union.",
      }),
    ).toBe("From the **union**.");
  });

  it("reads another app's markpub record", () => {
    expect(
      documentBodyMarkdown({
        content: {
          $type: "at.markpub.markdown",
          flavor: "commonmark",
          text: { markdown: "# Theirs" },
        },
        textContent: "Theirs",
      }),
    ).toBe("# Theirs");
  });

  it("prefers the full textContent over a textBlob record's preview", () => {
    const content = {
      $type: "at.markpub.markdown",
      text: { markdown: "Preview…", textBlob: { $type: "blob" } },
    };
    expect(
      documentBodyMarkdown({ content, textContent: "The whole piece." }),
    ).toBe("The whole piece.");
    expect(documentBodyMarkdown({ content })).toBe("Preview…");
  });

  it("union-less records read from textContent, which is markdown there", () => {
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

  it("keeps a hand-written subtitle recognisable on a markpub record", () => {
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

/**
 * The projection is allowed to be lossy. It is not allowed to be MANGLED —
 * and every case below used to be, because a construct-by-construct strip
 * passes through anything it does not recognize. `textContent` is what every
 * reader outside Goldroad falls back to, so markdown left standing in it is
 * the field failing at its only job.
 */
describe("plainTextBody: constructs the strip used to leave standing", () => {
  const plainTextBody = (markdown: string) =>
    projectBody(markdown, MAX_BODY_LENGTH);

  it("degrades a GFM table to readable lines instead of a pipe grid", () => {
    const body = [
      "| Plan | Price | Notes |",
      "| --- | ---: | :--- |",
      "| Free | $0 | Forever |",
      "| Pro | $9 | Monthly |",
    ].join("\n");
    const plain = plainTextBody(body);
    expect(plain).not.toContain("|");
    expect(plain).not.toContain("---");
    expect(plain).toBe(
      "Plan · Price · Notes\nFree · $0 · Forever\nPro · $9 · Monthly",
    );
  });

  it("keeps a cell's own escaped pipe as text", () => {
    expect(plainTextBody("| a \\| b | c |")).toBe("a | b · c");
  });

  it("keeps where a link pointed instead of deleting it", () => {
    // Losing the destination is not lossiness: the reader is left with words
    // that look like a link, point nowhere, and cannot be recovered.
    expect(plainTextBody("See [the docs](https://example.com/docs).")).toBe(
      "See the docs (https://example.com/docs).",
    );
    // A titled destination and the angle-bracket form are both legal spellings.
    expect(plainTextBody('[x](https://example.com "Title")')).toBe(
      "x (https://example.com)",
    );
    expect(plainTextBody("[x](<https://example.com/a b>)")).toBe(
      "x (https://example.com/a b)",
    );
    // Never says the same URL twice.
    expect(plainTextBody("[https://a.example](https://a.example)")).toBe(
      "https://a.example",
    );
  });

  it("leaves the excerpt's links as bare text, where a URL is only noise", () => {
    expect(stripMarkdown("See [the docs](https://example.com/docs).")).toBe(
      "See the docs.",
    );
  });

  it("resolves a reference link to its text and drops the definition", () => {
    const body = "Read [the paper][p] today.\n\n[p]: https://example.com/paper";
    expect(plainTextBody(body)).toBe("Read the paper today.");
  });

  it("drops footnote markers but keeps the notes themselves", () => {
    const body = "A claim.[^1]\n\n[^1]: The evidence for it.";
    const plain = plainTextBody(body);
    expect(plain).not.toContain("[^1]");
    expect(plain).toBe("A claim.\n\nThe evidence for it.");
  });

  it("drops setext underlines and thematic breaks, keeping the heading", () => {
    expect(plainTextBody("A Title\n=======\n\nBody.")).toBe("A Title\n\nBody.");
    expect(plainTextBody("A Sub\n-----\n\nBody.")).toBe("A Sub\n\nBody.");
    expect(plainTextBody("One.\n\n---\n\nTwo.")).toBe("One.\n\nTwo.");
    expect(plainTextBody("One.\n\n* * *\n\nTwo.")).toBe("One.\n\nTwo.");
  });

  it("turns task-list markers into plain lines", () => {
    expect(plainTextBody("- [ ] not done\n- [x] done")).toBe("not done\ndone");
  });

  it("stays linear on a hostile flood of the new constructs", {
    timeout: LINEAR_TEST_TIMEOUT_MS,
  }, () => {
    // [repeated unit, repeats in the smaller input]; the larger is 4x that.
    // The bracket floods stop at 50k characters, half the validated body
    // limit: this strip is slow enough per character on them that the full
    // limit makes the test slow on a loaded machine, and quadratic work shows
    // at that size anyway. The pipe flood is cheap per character, so it runs
    // at the full limit, where a cheap quadratic still outgrows the linear
    // part.
    const hostiles: Array<[string, number]> = [
      ["|", 25_000],
      ["[^", 6_250],
      ["[a][b", 2_500],
      ["|a\\|b|\n", 1_250],
    ];
    for (const [unit, n] of hostiles) {
      expectLinear(
        (body) => projectBody(body, MAX_BODY_LENGTH),
        (k) => unit.repeat(k),
        n,
      );
    }
  });
});
