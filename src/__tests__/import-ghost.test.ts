// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * Ghost content-export JSON parsing, against synthetic exports built in-test
 * (Ghost's own docs don't publish the field-level schema, so these fixtures
 * encode the shape verified in ghost.org/help/exports + the community
 * import/export tooling this codebase already cites for the Substack path).
 * Pins: the db[0].data.posts / data.posts / bare posts fallback chain, the
 * post/page type filter, the html-less-post honest failure, and the
 * paywall-stub flag shared with every other import path.
 */
import {
  constructGhostSourceUrl,
  ghostPostGuid,
  parseGhostExport,
} from "../lib/import-ghost";

const LONG_HTML = `<h2>A real post</h2>${`<p>${"substantial words ".repeat(40)}</p>`.repeat(3)}`;
const STUB_HTML = `<p>Short stub.</p>`;

function fullExport(posts: unknown[]) {
  return JSON.stringify({
    db: [{ meta: { version: "5.0" }, data: { posts } }],
  });
}

describe("parseGhostExport — happy path", () => {
  it("reads posts from the standard db[0].data.posts shape", () => {
    const parsed = parseGhostExport(
      fullExport([
        {
          id: "1",
          slug: "first-post",
          title: "First post",
          html: LONG_HTML,
          type: "post",
          status: "published",
          published_at: "2024-03-01T10:00:00.000Z",
        },
      ]),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].id).toBe("1");
    expect(parsed.posts[0].slug).toBe("first-post");
    expect(parsed.posts[0].publishedAtSource).toBe(true);
    expect(parsed.posts[0].publishedAt).toBe("2024-03-01T10:00:00.000Z");
  });

  it("falls back to a bare data.posts shape", () => {
    const parsed = parseGhostExport(
      JSON.stringify({
        data: {
          posts: [{ id: "2", title: "Second", html: LONG_HTML, type: "post" }],
        },
      }),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].id).toBe("2");
  });

  it("falls back to a bare top-level posts array", () => {
    const parsed = parseGhostExport(
      JSON.stringify({
        posts: [{ id: "3", title: "Third", html: LONG_HTML, type: "post" }],
      }),
    );
    expect(parsed.posts).toHaveLength(1);
  });

  it("uses uuid when id is absent", () => {
    const parsed = parseGhostExport(
      fullExport([
        {
          uuid: "abc-uuid",
          title: "Untitled id",
          html: LONG_HTML,
          type: "post",
        },
      ]),
    );
    expect(parsed.posts[0].id).toBe("abc-uuid");
  });

  it("newest first", () => {
    const parsed = parseGhostExport(
      fullExport([
        {
          id: "old",
          title: "Old",
          html: LONG_HTML,
          type: "post",
          published_at: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "new",
          title: "New",
          html: LONG_HTML,
          type: "post",
          published_at: "2024-06-01T00:00:00.000Z",
        },
      ]),
    );
    expect(parsed.posts.map((p) => p.id)).toEqual(["new", "old"]);
  });
});

describe("parseGhostExport — per-item honesty", () => {
  it("skips pages, counted, never imported as posts", () => {
    const parsed = parseGhostExport(
      fullExport([
        { id: "1", title: "A post", html: LONG_HTML, type: "post" },
        { id: "2", title: "A page", html: LONG_HTML, type: "page" },
      ]),
    );
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.skippedPages).toBe(1);
  });

  it("a post with no usable html surfaces as a per-item failure, not blank content", () => {
    const parsed = parseGhostExport(
      fullExport([
        { id: "1", title: "Lexical-only", type: "post", lexical: "{}" },
        { id: "2", title: "Fine", html: LONG_HTML, type: "post" },
      ]),
    );
    expect(parsed.posts.map((p) => p.id)).toEqual(["2"]);
    expect(parsed.failures).toEqual([{ id: "1", reason: "no_html" }]);
  });

  it("flags teaser-length html as a possible stub", () => {
    const parsed = parseGhostExport(
      fullExport([
        { id: "1", title: "Stub", html: STUB_HTML, type: "post" },
        { id: "2", title: "Real", html: LONG_HTML, type: "post" },
      ]),
    );
    expect(parsed.posts.find((p) => p.id === "1")?.preview).toBe(true);
    expect(parsed.posts.find((p) => p.id === "2")?.preview).toBe(false);
  });

  it("draft status is reported, never treated as published", () => {
    const parsed = parseGhostExport(
      fullExport([
        {
          id: "1",
          title: "Draft",
          html: LONG_HTML,
          type: "post",
          status: "draft",
        },
      ]),
    );
    expect(parsed.posts[0].publishedAtSource).toBe(false);
  });
});

describe("parseGhostExport — defensive paths", () => {
  it("malformed JSON yields zero posts, never throws", () => {
    expect(parseGhostExport("not json at all").posts).toEqual([]);
  });

  it("an unrecognized shape yields zero posts, never throws", () => {
    expect(parseGhostExport(JSON.stringify({ hello: "world" })).posts).toEqual(
      [],
    );
  });

  it("caps at MAX_EXPORT_POSTS and reports the rest as truncated", async () => {
    const { MAX_EXPORT_POSTS } = await import("../lib/import");
    const posts = Array.from({ length: MAX_EXPORT_POSTS + 3 }, (_, i) => ({
      id: `${i}`,
      title: `Post ${i}`,
      html: LONG_HTML,
      type: "post",
    }));
    const parsed = parseGhostExport(fullExport(posts));
    expect(parsed.posts).toHaveLength(MAX_EXPORT_POSTS);
    expect(parsed.truncated).toBe(3);
  });
});

describe("identity + provenance helpers", () => {
  it("namespaces export guids so re-uploads dedupe and other sources can't collide", () => {
    expect(ghostPostGuid("1")).toBe("ghost-export:1");
  });

  it("builds https provenance URLs only from clean host + slug", () => {
    expect(constructGhostSourceUrl("blog.example.com", "first-post")).toBe(
      "https://blog.example.com/first-post/",
    );
    expect(constructGhostSourceUrl(null, "first-post")).toBeNull();
    expect(constructGhostSourceUrl("blog.example.com", "")).toBeNull();
    expect(constructGhostSourceUrl("blog.example.com", "a/../b")).toBeNull();
  });
});
