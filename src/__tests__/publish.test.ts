// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildDocumentRecord,
  buildPublicationRecord,
  composeDocumentUrl,
  excerpt,
  generateTid,
  isOwnPublicationUrl,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  TID_RE,
  updateDocumentRecord,
} from "../lib/publish";

describe("generateTid", () => {
  it("emits 13 chars of base32-sortable alphabet", () => {
    const tid = generateTid();
    expect(tid).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  });

  it("sorts lexicographically by timestamp", () => {
    const earlier = generateTid(1_700_000_000_000, 0);
    const later = generateTid(1_800_000_000_000, 0);
    expect(earlier < later).toBe(true);
  });

  it("is deterministic for fixed inputs", () => {
    expect(generateTid(1_700_000_000_000, 5)).toBe(
      generateTid(1_700_000_000_000, 5),
    );
  });

  it("matches TID_RE (the lexicon record-key type for documents and publications)", () => {
    expect(generateTid()).toMatch(TID_RE);
    expect(TID_RE.test("not-a-tid")).toBe(false);
    expect(TID_RE.test("3lyk73wxnok2f")).toBe(true);
  });
});

describe("excerpt", () => {
  it("collapses whitespace", () => {
    expect(excerpt("a\n\nb\t c")).toBe("a b c");
  });
  it("truncates long bodies with an ellipsis", () => {
    const out = excerpt("word ".repeat(200));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });
  it("strips markdown syntax — descriptions render as plain text in cards", () => {
    expect(
      excerpt(
        "# Heading\n\nSome **bold** and _italic_ text with a [link](https://example.com).",
      ),
    ).toBe("Heading Some bold and italic text with a link.");
    expect(excerpt("- one\n- two\n\n> quoted")).toBe("one two quoted");
    expect(excerpt("intro\n\n```js\nconst x = 1;\n```\n\noutro")).toBe(
      "intro outro",
    );
    expect(excerpt("![a diagram](https://example.com/x.png) caption")).toBe(
      "a diagram caption",
    );
  });

  // Pinned fixtures: freeze the exact output on representative writer
  // markdown so refactors of the stripping pipeline provably change nothing
  // on normal inputs.
  it("pins the exact output for a representative post body", () => {
    const post = [
      "# The Gold Road",
      "",
      "An **opening** paragraph with _emphasis_, `inline code`, and a",
      "[link](https://example.com/post) plus an image",
      "![press photo](https://example.com/press.jpg).",
      "",
      "> An editor's note: a quoted line.",
      "",
      "- first point",
      "* second point",
      "3. numbered step",
      "",
      "```js",
      'const hidden = "never shown";',
      "```",
      "",
      "A closing paragraph.",
    ].join("\n");
    expect(excerpt(post)).toBe(
      "The Gold Road An opening paragraph with emphasis, inline code, and a " +
        "link plus an image press photo. An editor's note: a quoted line. " +
        "first point second point numbered step A closing paragraph.",
    );
  });

  it("pins the exact truncation shape: hard cut at 299 chars + ellipsis", () => {
    // No word-boundary logic in excerpt(): a 400-char unbroken body cuts at
    // exactly 299 chars and appends the ellipsis (total 300).
    expect(excerpt("a".repeat(400))).toBe(`${"a".repeat(299)}…`);
  });

  it("pins the boundary: exactly 300 collapsed chars pass through untruncated", () => {
    const body = "a".repeat(300);
    expect(excerpt(body)).toBe(body);
  });

  it("pins trailing-whitespace trim before the ellipsis", () => {
    // The 299-char cut lands on a space (index 298); trimEnd drops it, so
    // the ellipsis attaches directly to the last word.
    const out = excerpt(`${"x".repeat(298)} word`);
    expect(out).toBe(`${"x".repeat(298)}…`);
  });
});

describe("buildDocumentRecord", () => {
  const input = {
    title: "  Hello Atmosphere  ",
    body: "First paragraph.\r\n\r\nSecond paragraph.",
    site: "https://goldroad.example/",
    path: "/p/writer.example/3abc",
  };

  it("shapes a site.standard.document with required fields", () => {
    const record = buildDocumentRecord(input);
    expect(record.$type).toBe("site.standard.document");
    expect(record.title).toBe("Hello Atmosphere");
    expect(record.site).toBe("https://goldroad.example"); // no trailing slash
    expect(record.path).toBe("/p/writer.example/3abc");
    expect(Date.parse(record.publishedAt)).not.toBeNaN();
  });

  it("stores the body in textContent with normalized newlines + a description excerpt", () => {
    const record = buildDocumentRecord(input);
    expect(record.textContent).toBe("First paragraph.\n\nSecond paragraph.");
    expect(record.description).toBe("First paragraph. Second paragraph.");
  });

  it("omits textContent/description for empty bodies", () => {
    const record = buildDocumentRecord({ ...input, body: "   " });
    expect(record.textContent).toBeUndefined();
    expect(record.description).toBeUndefined();
  });

  it("references the uploaded cover blob (the reference keeps it alive on the PDS)", () => {
    const coverImage = {
      $type: "blob" as const,
      ref: { $link: "bafkreicanarycovercid000000000000000000000" },
      mimeType: "image/jpeg",
      size: 4096,
    };
    expect(buildDocumentRecord({ ...input, coverImage }).coverImage).toEqual(
      coverImage,
    );
    expect(buildDocumentRecord(input).coverImage).toBeUndefined();
  });

  it("rejects missing or oversized input", () => {
    expect(() => buildDocumentRecord({ ...input, title: " " })).toThrow(
      "title is required",
    );
    expect(() =>
      buildDocumentRecord({
        ...input,
        title: "x".repeat(MAX_TITLE_LENGTH + 1),
      }),
    ).toThrow("title exceeds");
    expect(() =>
      buildDocumentRecord({ ...input, body: "x".repeat(MAX_BODY_LENGTH + 1) }),
    ).toThrow("body exceeds");
  });

  it("accepts a publication AT-URI as site and composes path as /<rkey>", () => {
    const record = buildDocumentRecord({
      ...input,
      site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
      path: "/3abc2345678df",
    });
    expect(record.site).toBe(
      "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
    );
    expect(record.path).toBe("/3abc2345678df");
  });
});

describe("updateDocumentRecord", () => {
  const existing = {
    $type: "site.standard.document",
    title: "Old title",
    description: "Old excerpt",
    textContent: "Old body",
    site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
    path: "/3abc2345678df",
    publishedAt: "2026-07-01T00:00:00.000Z",
    tags: ["keep-me"],
  };

  it("replaces title/body, preserves publishedAt/site/path/other fields, stamps updatedAt", () => {
    const record = updateDocumentRecord(existing, {
      title: "New title",
      body: "New **body**",
    });
    expect(record.title).toBe("New title");
    expect(record.textContent).toBe("New **body**");
    expect(record.description).toBe("New body");
    expect(record.publishedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(record.site).toBe(existing.site);
    expect(record.path).toBe(existing.path);
    expect(record.tags).toEqual(["keep-me"]);
    expect(Date.parse(record.updatedAt ?? "")).not.toBeNaN();
  });

  it("refuses documents that carry a rich content union (would silently fork them)", () => {
    expect(() =>
      updateDocumentRecord(
        { ...existing, content: { $type: "pub.leaflet.content" } },
        { title: "t", body: "b" },
      ),
    ).toThrow("rich content");
  });

  it("refuses records without a valid site", () => {
    expect(() =>
      updateDocumentRecord(
        { ...existing, site: undefined },
        {
          title: "t",
          body: "b",
        },
      ),
    ).toThrow("no valid site");
  });

  it("clears textContent/description when the body is emptied", () => {
    const record = updateDocumentRecord(existing, { title: "t", body: "  " });
    expect(record.textContent).toBeUndefined();
    expect(record.description).toBeUndefined();
    // undefined keys vanish on the wire — JSON.stringify drops them.
    expect(JSON.parse(JSON.stringify(record)).textContent).toBeUndefined();
  });

  it("preserves the announce write-back (bskyPostRef) across edits", () => {
    const bskyPostRef = {
      uri: "at://did:plc:fake0000000000writer0000/app.bsky.feed.post/3lz2post2key2",
      cid: "bafyreib-canary-not-a-real-cid",
    };
    const record = updateDocumentRecord(
      { ...existing, bskyPostRef },
      { title: "t", body: "b" },
    );
    expect(
      (record as { bskyPostRef?: typeof bskyPostRef }).bskyPostRef,
    ).toEqual(bskyPostRef);
  });

  describe("coverImage semantics (blob = replace, null = remove, undefined = keep)", () => {
    const cover = {
      $type: "blob" as const,
      ref: { $link: "bafkreicanaryoldcover00000000000000000000" },
      mimeType: "image/jpeg",
      size: 4096,
    };
    const newCover = {
      ...cover,
      ref: { $link: "bafkreicanarynewcover00000000000000000000" },
    };
    const withCover = { ...existing, coverImage: cover };

    it("keeps the existing cover when coverImage is undefined", () => {
      const record = updateDocumentRecord(withCover, {
        title: "t",
        body: "b",
      });
      expect(record.coverImage).toEqual(cover);
    });

    it("replaces the cover when a blob is given", () => {
      const record = updateDocumentRecord(withCover, {
        title: "t",
        body: "b",
        coverImage: newCover,
      });
      expect(record.coverImage).toEqual(newCover);
    });

    it("removes the cover when null is given — the wire drops the key", () => {
      const record = updateDocumentRecord(withCover, {
        title: "t",
        body: "b",
        coverImage: null,
      });
      expect(record.coverImage).toBeUndefined();
      expect("coverImage" in JSON.parse(JSON.stringify(record))).toBe(false);
    });
  });
});

describe("buildPublicationRecord", () => {
  it("shapes a site.standard.publication with url stripped of trailing slashes", () => {
    const record = buildPublicationRecord({
      name: "  My Publication  ",
      description: "About things.",
      url: "https://goldroad.example/@writer.example/",
    });
    expect(record.$type).toBe("site.standard.publication");
    expect(record.name).toBe("My Publication");
    expect(record.description).toBe("About things.");
    expect(record.url).toBe("https://goldroad.example/@writer.example");
  });

  it("preserves fields other apps wrote (basicTheme, preferences, …) when updating", () => {
    const record = buildPublicationRecord(
      { name: "Renamed", url: "https://goldroad.example/@writer.example" },
      {
        name: "Old",
        url: "https://goldroad.example/@old-handle.example",
        // simulating fields our type doesn't model:
        ...({ preferences: { showInDiscover: false } } as object),
      },
    );
    expect(record.name).toBe("Renamed");
    expect(record.url).toBe("https://goldroad.example/@writer.example");
    expect(
      (record as { preferences?: { showInDiscover?: boolean } }).preferences,
    ).toEqual({ showInDiscover: false });
    expect(record.description).toBeUndefined();
  });

  it("rejects missing name and non-http urls", () => {
    expect(() =>
      buildPublicationRecord({ name: " ", url: "https://x.example" }),
    ).toThrow("name is required");
    expect(() =>
      buildPublicationRecord({ name: "n", url: "at://did:plc:x/y/z" }),
    ).toThrow("http(s)");
  });
});

describe("composeDocumentUrl", () => {
  const pubUrl = "https://goldroad.example/@writer.example";

  it("composes publication.url + document.path for at:// sites", () => {
    expect(
      composeDocumentUrl({
        site: "at://did:plc:fake0000000000writer0000/site.standard.publication/3abc2345678de",
        path: "/3abc2345678df",
        publicationUrl: pubUrl,
      }),
    ).toBe(`${pubUrl}/3abc2345678df`);
  });

  it("uses an https site directly (loose documents), normalizing trailing slashes", () => {
    expect(
      composeDocumentUrl({
        site: "https://awarm.leaflet.pub/",
        path: "/3lyk73wxnok2f",
      }),
    ).toBe("https://awarm.leaflet.pub/3lyk73wxnok2f");
  });

  it("returns null when the pieces don't compose", () => {
    // at:// site with no resolved publication URL
    expect(
      composeDocumentUrl({ site: "at://did:plc:x/y/z", path: "/3abc" }),
    ).toBeNull();
    // missing or non-rooted path
    expect(
      composeDocumentUrl({ site: "https://x.example", path: undefined }),
    ).toBeNull();
    expect(
      composeDocumentUrl({ site: "https://x.example", path: "3abc" }),
    ).toBeNull();
    // http publication URL is not a canonical web location
    expect(
      composeDocumentUrl({
        site: "at://did:plc:x/y/z",
        path: "/3abc",
        publicationUrl: "http://insecure.example",
      }),
    ).toBeNull();
  });

  it("refuses bases with query/fragment (would absorb the path) — omit, never mangle", () => {
    expect(
      composeDocumentUrl({ site: "https://x.example/?q=1", path: "/3abc" }),
    ).toBeNull();
    expect(
      composeDocumentUrl({
        site: "at://did:plc:x/y/z",
        path: "/3abc",
        publicationUrl: "https://x.example/#top",
      }),
    ).toBeNull();
  });
});

describe("isOwnPublicationUrl", () => {
  // The real production matrix: canonical + legacy origins, as produced by
  // ownOrigins() in ~/lib/origin.
  const origins = [
    "https://trygoldroad.com",
    "https://goldroad.kibuchi.workers.dev",
  ];

  it("matches canonical-origin publications regardless of the handle in the path", () => {
    expect(
      isOwnPublicationUrl("https://trygoldroad.com/@writer.example", origins),
    ).toBe(true);
    expect(
      isOwnPublicationUrl(
        "https://trygoldroad.com/@old-handle.example",
        origins,
      ),
    ).toBe(true);
    expect(isOwnPublicationUrl("https://trygoldroad.com", origins)).toBe(true);
  });

  it("matches legacy workers.dev publications (pre-migration records stay ours)", () => {
    expect(
      isOwnPublicationUrl(
        "https://goldroad.kibuchi.workers.dev/@writer.example",
        origins,
      ),
    ).toBe(true);
  });

  it("matches dev-origin publications when the loopback origin is in the list", () => {
    const devOrigins = ["http://127.0.0.1:3000", ...origins];
    expect(
      isOwnPublicationUrl("http://127.0.0.1:3000/@writer.example", devOrigins),
    ).toBe(true);
    // …but not when it isn't (production never claims loopback URLs).
    expect(
      isOwnPublicationUrl("http://127.0.0.1:3000/@writer.example", origins),
    ).toBe(false);
  });

  it("never matches publications owned by other apps", () => {
    expect(isOwnPublicationUrl("https://awarm.leaflet.pub", origins)).toBe(
      false,
    );
    expect(isOwnPublicationUrl(undefined, origins)).toBe(false);
  });

  it("never matches lookalike prefixes of our origins", () => {
    expect(
      isOwnPublicationUrl("https://trygoldroad.com.evil.tld/@x", origins),
    ).toBe(false);
    expect(
      isOwnPublicationUrl("https://trygoldroad.community/@x", origins),
    ).toBe(false);
    expect(
      isOwnPublicationUrl(
        "https://goldroad.kibuchi.workers.dev.evil.tld/@x",
        origins,
      ),
    ).toBe(false);
  });
});
