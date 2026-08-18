// @vitest-environment node
/**
 * Thread import's conversion logic (~/lib/threads), driven directly.
 *
 * The AppView shapes here are the ones verified against the live public
 * endpoints (see the module header): a feedViewPost is `{ post, reply?,
 * reason? }`, a threadViewPost is `{ post, replies }`, facet `index` is a BYTE
 * range, an image view carries `fullsize` + `alt`.
 *
 * What these tests are actually about is the set of promises the feature makes
 * to a writer: my own spine and nobody else's, my links where I put them, my
 * pictures with my descriptions, and a stranger's post never inside my record.
 */
import { describe, expect, it, vi } from "vitest";

import {
  assembleThread,
  discoverAuthorThreads,
  discoverThreads,
  embedMarkdown,
  escapeMarkdownText,
  MAX_THREAD_DISCOVERY_PAGES,
  MAX_THREAD_POSTS,
  MAX_THREAD_RESPONSE_BYTES,
  normalizePost,
  postTextMarkdown,
  resolveFacets,
  type ThreadPost,
  threadTitle,
} from "../lib/threads";

const ME = "did:plc:fake2222222222writer2222";
const THEM = "did:plc:fake3333333333reader3333";

function uri(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

/** A #postView as the AppView sends one. */
function postView(opts: {
  did?: string;
  rkey: string;
  text?: string;
  createdAt?: string;
  parent?: string;
  root?: string;
  facets?: unknown[];
  embed?: unknown;
}) {
  const did = opts.did ?? ME;
  return {
    uri: uri(did, opts.rkey),
    cid: `cid-${opts.rkey}`,
    author: { did, handle: did === ME ? "me.example" : "them.example" },
    record: {
      $type: "app.bsky.feed.post",
      createdAt: opts.createdAt ?? "2026-02-04T10:00:00.000Z",
      text: opts.text ?? "",
      ...(opts.facets ? { facets: opts.facets } : {}),
      ...(opts.parent
        ? {
            reply: {
              parent: { uri: opts.parent, cid: "c" },
              root: { uri: opts.root ?? opts.parent, cid: "c" },
            },
          }
        : {}),
    },
    ...(opts.embed ? { embed: opts.embed } : {}),
    indexedAt: "2026-02-04T10:00:01.000Z",
  };
}

function feedPage(items: unknown[]) {
  return { feed: items, cursor: null };
}

/** A threadViewPost node. */
function node(post: unknown, replies: unknown[] = []) {
  return { $type: "app.bsky.feed.defs#threadViewPost", post, replies };
}

/**
 * normalizePost, insisting. A fixture that doesn't reduce to a post is a broken
 * fixture, and failing loudly here beats a null slipping into an assertion that
 * then passes for the wrong reason.
 */
function ownPost(view: unknown, author: string = ME): ThreadPost {
  const post = normalizePost(view, author);
  if (!post) throw new Error("fixture did not reduce to one of my posts");
  return post;
}

// ---------------------------------------------------------------- discovery

describe("discovery — what counts as a thread", () => {
  it("finds a root with its own replies chained on, and counts the spine", () => {
    const { threads } = discoverThreads(
      [
        feedPage([
          {
            post: postView({
              rkey: "3a3",
              text: "third",
              parent: uri(ME, "3a2"),
              root: uri(ME, "3a1"),
              createdAt: "2026-02-04T10:02:00.000Z",
            }),
          },
          {
            post: postView({
              rkey: "3a2",
              text: "second",
              parent: uri(ME, "3a1"),
              root: uri(ME, "3a1"),
              createdAt: "2026-02-04T10:01:00.000Z",
            }),
          },
          {
            post: postView({
              rkey: "3a1",
              text: "On leaving\nthe second line",
              createdAt: "2026-02-04T10:00:00.000Z",
            }),
          },
        ]),
      ],
      ME,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].rootUri).toBe(uri(ME, "3a1"));
    expect(threads[0].postCount).toBe(3);
    expect(threads[0].title).toBe("On leaving");
    expect(threads[0].createdAt).toBe("2026-02-04T10:00:00.000Z");
    expect(threads[0].url).toBe(`https://bsky.app/profile/${ME}/post/3a1`);
  });

  it("a single post is not a thread (v1 scope)", () => {
    const { threads } = discoverThreads(
      [feedPage([{ post: postView({ rkey: "3b1", text: "just a post" }) }])],
      ME,
    );
    expect(threads).toEqual([]);
  });

  it("ignores replies by OTHER people hanging off my root", () => {
    const { threads } = discoverThreads(
      [
        feedPage([
          { post: postView({ rkey: "3c1", text: "my root" }) },
          {
            post: postView({
              did: THEM,
              rkey: "3c2",
              text: "someone answering",
              parent: uri(ME, "3c1"),
            }),
          },
        ]),
      ],
      ME,
    );
    // My root plus a stranger's reply is a conversation, not a piece of mine.
    expect(threads).toEqual([]);
  });

  it("ignores my chain when it hangs off SOMEONE ELSE'S post", () => {
    const { threads } = discoverThreads(
      [
        feedPage([
          {
            post: postView({
              rkey: "3d1",
              text: "my long answer",
              parent: uri(THEM, "3d0"),
              root: uri(THEM, "3d0"),
            }),
          },
          {
            post: postView({
              rkey: "3d2",
              text: "…continued",
              parent: uri(ME, "3d1"),
              root: uri(THEM, "3d0"),
              createdAt: "2026-02-04T10:05:00.000Z",
            }),
          },
        ]),
      ],
      ME,
    );
    // Participation in a stranger's conversation, not a standalone document.
    expect(threads).toEqual([]);
  });

  it("ignores reposts", () => {
    const { threads } = discoverThreads(
      [
        feedPage([
          {
            post: postView({ did: THEM, rkey: "3e1", text: "their post" }),
            reason: { $type: "app.bsky.feed.defs#reasonRepost" },
          },
        ]),
      ],
      ME,
    );
    expect(threads).toEqual([]);
  });

  it("takes the EARLIEST self-reply when a thread branches", () => {
    const { threads } = discoverThreads(
      [
        feedPage([
          { post: postView({ rkey: "3f1", text: "root" }) },
          // Deliberately out of date order in the page — the spine must not
          // depend on how the AppView happened to sort it.
          {
            post: postView({
              rkey: "3f3",
              text: "the afterthought",
              parent: uri(ME, "3f1"),
              createdAt: "2026-02-04T12:00:00.000Z",
            }),
          },
          {
            post: postView({
              rkey: "3f2",
              text: "the real second",
              parent: uri(ME, "3f1"),
              createdAt: "2026-02-04T10:01:00.000Z",
            }),
          },
        ]),
      ],
      ME,
    );
    expect(threads[0].postCount).toBe(2);
  });

  it("lists newest first", () => {
    const { threads } = discoverThreads(
      [
        feedPage([
          {
            post: postView({
              rkey: "3g1",
              text: "older",
              createdAt: "2025-01-01T00:00:00.000Z",
            }),
          },
          {
            post: postView({
              rkey: "3g2",
              text: "older reply",
              parent: uri(ME, "3g1"),
              createdAt: "2025-01-01T00:01:00.000Z",
            }),
          },
          {
            post: postView({
              rkey: "3h1",
              text: "newer",
              createdAt: "2026-06-01T00:00:00.000Z",
            }),
          },
          {
            post: postView({
              rkey: "3h2",
              text: "newer reply",
              parent: uri(ME, "3h1"),
              createdAt: "2026-06-01T00:01:00.000Z",
            }),
          },
        ]),
      ],
      ME,
    );
    expect(threads.map((t) => t.title)).toEqual(["newer", "older"]);
  });

  it("survives a page of junk without inventing threads", () => {
    const { threads } = discoverThreads(
      [
        null,
        "nope",
        { feed: "not an array" },
        { feed: [null, {}, { post: {} }] },
      ],
      ME,
    );
    expect(threads).toEqual([]);
  });
});

describe("normalizePost — attribution is right or absent", () => {
  it("refuses a post whose author DID disagrees with its own URI", () => {
    const view = postView({ rkey: "3i1", text: "x" });
    view.author.did = THEM;
    expect(normalizePost(view, ME)).toBeNull();
  });

  it("refuses a URI in another collection", () => {
    expect(
      normalizePost(
        {
          ...postView({ rkey: "3i2" }),
          uri: `at://${ME}/app.bsky.feed.like/3i2`,
        },
        ME,
      ),
    ).toBeNull();
  });

  it("falls back to indexedAt when the record's own date is unusable", () => {
    const view = postView({ rkey: "3i3", text: "x" });
    view.record.createdAt = "not a date";
    expect(normalizePost(view, ME)?.createdAt).toBe("2026-02-04T10:00:01.000Z");
  });
});

// ------------------------------------------------------------------- titles

describe("threadTitle", () => {
  it("takes the first non-empty line as written — no de-numbering", () => {
    expect(threadTitle("1/ Why I left\n\nthe rest")).toBe("1/ Why I left");
    expect(threadTitle("\n\n  Leading blanks  \nnext")).toBe("Leading blanks");
  });

  it("clamps a first line that is really a paragraph", () => {
    const title = threadTitle("word ".repeat(60));
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("names an empty root rather than titling it nothing", () => {
    expect(threadTitle("   \n  ")).toBe("Untitled thread");
  });
});

// ------------------------------------------------------------------- facets

describe("facets → markdown (never a regex over the text)", () => {
  function linkFacet(byteStart: number, byteEnd: number, target: string) {
    return {
      $type: "app.bsky.richtext.facet",
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: target }],
    };
  }

  it("applies a link facet by BYTE offset, not character offset", () => {
    // "café — see docs" : "café" is 5 bytes, so the byte offsets past it are
    // one higher than the character offsets. A character-indexed
    // implementation puts the link on the wrong words here.
    const text = "café — see docs";
    const bytes = new TextEncoder().encode(text);
    const start = bytes.length - "docs".length;
    const post = ownPost(
      postView({
        rkey: "3j1",
        text,
        facets: [linkFacet(start, bytes.length, "https://example.com/d")],
      }),
      ME,
    );
    expect(postTextMarkdown(post)).toEqual([
      "café — see [docs](https://example.com/d)",
    ]);
  });

  it("links a mention to the mentioned DID, labelled with the handle as typed", () => {
    const text = "thanks @friend.example";
    const bytes = new TextEncoder().encode(text);
    const post = ownPost(
      postView({
        rkey: "3j2",
        text,
        facets: [
          {
            index: { byteStart: text.indexOf("@"), byteEnd: bytes.length },
            features: [{ $type: "app.bsky.richtext.facet#mention", did: THEM }],
          },
        ],
      }),
      ME,
    );
    expect(postTextMarkdown(post)).toEqual([
      `thanks [@friend.example](https://bsky.app/profile/${THEM})`,
    ]);
  });

  it("leaves a hashtag as plain text", () => {
    const text = "on #writing";
    const post = ownPost(
      postView({
        rkey: "3j3",
        text,
        facets: [
          {
            index: { byteStart: 3, byteEnd: 11 },
            features: [
              { $type: "app.bsky.richtext.facet#tag", tag: "writing" },
            ],
          },
        ],
      }),
      ME,
    );
    // Mid-line, so it needs no escape either: an ATX heading only exists at the
    // start of a line, which is the only place the escape is applied.
    expect(postTextMarkdown(post)).toEqual(["on #writing"]);
  });

  it("refuses a non-https link target — the words stay, the link doesn't", () => {
    for (const target of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "http://old.example/x",
    ]) {
      const post = ownPost(
        postView({
          rkey: "3j4",
          text: "click here",
          facets: [linkFacet(6, 10, target)],
        }),
        ME,
      );
      expect(postTextMarkdown(post)).toEqual(["click here"]);
    }
  });

  it("drops out-of-range, inverted and overlapping ranges", () => {
    const resolved = resolveFacets(
      [
        linkFacet(0, 4, "https://a.example"),
        linkFacet(2, 6, "https://b.example"), // overlaps the first
        linkFacet(-1, 3, "https://c.example"), // negative
        linkFacet(5, 5, "https://d.example"), // empty
        linkFacet(9, 4, "https://e.example"), // inverted
        linkFacet(4, 999, "https://f.example"), // past the end
      ],
      new TextEncoder().encode("abcdefghij"),
    );
    expect(resolved).toEqual([{ start: 0, end: 4, href: "https://a.example" }]);
  });

  /**
   * Two ranges that are perfectly in-bounds and still wrong. Facet offsets come
   * from other people's clients and some of them count wrong, so "inside the
   * text" is not the same as "usable".
   *
   * Both drop the FACET and keep the TEXT: the words are the writer's and always
   * survive; only the link decoration is refused.
   */
  it("drops a range that cuts a codepoint in half", () => {
    // "café" — the é is two bytes (0xC3 0xA9) at offsets 3 and 4. A range
    // ending at 4 lands INSIDE that character, so decoding either side emits
    // U+FFFD: the writer's own word arrives corrupted, welded to a link label,
    // permanently, in a record published under their name.
    const text = "café time";
    const bytes = new TextEncoder().encode(text);
    expect(bytes[3]).toBe(0xc3); // lead byte
    expect(bytes[4]).toBe(0xa9); // continuation byte

    expect(
      resolveFacets([linkFacet(0, 4, "https://a.example")], bytes),
    ).toEqual([]);
    // Starting mid-character is refused for the same reason.
    expect(
      resolveFacets([linkFacet(4, 9, "https://a.example")], bytes),
    ).toEqual([]);
    // The whole character is fine — this is a boundary check, not a ban.
    expect(
      resolveFacets([linkFacet(0, 5, "https://a.example")], bytes),
    ).toEqual([{ start: 0, end: 5, href: "https://a.example" }]);
  });

  it("drops a range that spans a newline", () => {
    // Every newline starts a new paragraph here, so a label containing one
    // would be split across two blocks with its markdown torn in half — `[half`
    // in one paragraph and `](url)` in the next, rendering as literal brackets.
    const text = "first line\nsecond line";
    const bytes = new TextEncoder().encode(text);
    expect(
      resolveFacets([linkFacet(6, 17, "https://a.example")], bytes),
    ).toEqual([]);
    // Wholly within one line, still fine.
    expect(
      resolveFacets([linkFacet(0, 5, "https://a.example")], bytes),
    ).toEqual([{ start: 0, end: 5, href: "https://a.example" }]);
  });

  it("keeps the words when it refuses the facet", () => {
    // The text is never the casualty — only the link decoration is dropped.
    const post = ownPost(
      postView({
        rkey: "3j9",
        text: "café time",
        facets: [linkFacet(0, 4, "https://a.example")],
      }),
    );
    expect(postTextMarkdown(post)).toEqual(["café time"]);
  });
});

describe("escapeMarkdownText — plain text stays plain", () => {
  it("keeps asterisks and underscores literal", () => {
    expect(escapeMarkdownText("*not emphasis* and _not italic_")).toBe(
      "\\*not emphasis\\* and \\_not italic\\_",
    );
  });

  it("stops a line-leading marker becoming a heading, quote or list", () => {
    expect(escapeMarkdownText("# not a heading")).toBe("\\# not a heading");
    expect(escapeMarkdownText("> not a quote")).toBe("\\> not a quote");
    expect(escapeMarkdownText("- not a list")).toBe("\\- not a list");
    expect(escapeMarkdownText("1. not a list")).toBe("1\\. not a list");
  });
});

describe("line handling", () => {
  it("makes a paragraph per line and drops blank runs", () => {
    const post = ownPost(
      postView({ rkey: "3k1", text: "one\n\n\ntwo\n   \nthree" }),
      ME,
    );
    expect(postTextMarkdown(post)).toEqual(["one", "two", "three"]);
  });

  it("an empty post contributes nothing", () => {
    const post = ownPost(postView({ rkey: "3k2", text: "  " }), ME);
    expect(postTextMarkdown(post)).toEqual([]);
  });
});

// ------------------------------------------------------------------- embeds

describe("embeds", () => {
  function withEmbed(embed: unknown, text = "words") {
    return ownPost(postView({ rkey: "3l1", text, embed }));
  }

  it("carries an image with its alt text as the markdown alt", () => {
    const { blocks } = embedMarkdown(
      withEmbed({
        $type: "app.bsky.embed.images#view",
        images: [
          {
            fullsize: "https://cdn.bsky.app/img/feed_fullsize/plain/x/y@jpeg",
            thumb: "https://cdn.bsky.app/img/feed_thumbnail/plain/x/y@jpeg",
            alt: "friendship ended with btrfs",
          },
        ],
      }),
    );
    expect(blocks).toEqual([
      "![friendship ended with btrfs](https://cdn.bsky.app/img/feed_fullsize/plain/x/y@jpeg)",
    ]);
  });

  it("emits an empty alt rather than inventing one", () => {
    const { blocks } = embedMarkdown(
      withEmbed({
        images: [{ fullsize: "https://cdn.bsky.app/img/x.jpg", alt: "" }],
      }),
    );
    expect(blocks).toEqual(["![](https://cdn.bsky.app/img/x.jpg)"]);
  });

  it("caps images at the lexicon's four", () => {
    const { blocks } = embedMarkdown(
      withEmbed({
        images: Array.from({ length: 9 }, (_, i) => ({
          fullsize: `https://cdn.bsky.app/img/${i}.jpg`,
          alt: `pic ${i}`,
        })),
      }),
    );
    expect(blocks).toHaveLength(4);
  });

  it("turns a quote of someone else into a LINK, never their words", () => {
    const { blocks } = embedMarkdown(
      withEmbed({
        $type: "app.bsky.embed.record#view",
        record: {
          uri: uri(THEM, "3m1"),
          author: { did: THEM, handle: "them.example" },
          value: { text: "THEIR ACTUAL WORDS", $type: "app.bsky.feed.post" },
        },
      }),
    );
    expect(blocks).toEqual([
      `Quoting [@them.example](https://bsky.app/profile/them.example/post/3m1)`,
    ]);
    expect(blocks.join("")).not.toContain("THEIR ACTUAL WORDS");
  });

  it("says nothing about a quote it cannot attribute", () => {
    // Deleted (#viewNotFound), blocked, and a handle/DID mismatch all land here.
    for (const record of [
      { $type: "app.bsky.embed.record#viewNotFound", notFound: true },
      { uri: uri(THEM, "3m2"), author: { did: ME, handle: "them.example" } },
      { uri: uri(THEM, "3m3") },
    ]) {
      expect(embedMarkdown(withEmbed({ record })).blocks).toEqual([]);
    }
  });

  it("keeps a link card, unless the same URL is already linked in the text", () => {
    const carded = embedMarkdown(
      withEmbed({
        external: {
          uri: "https://example.com/piece",
          title: "A piece worth reading",
        },
      }),
    );
    expect(carded.blocks).toEqual([
      "[A piece worth reading](https://example.com/piece)",
    ]);

    const text = "read https://example.com/piece";
    const duplicated = embedMarkdown(
      ownPost(
        postView({
          rkey: "3m4",
          text,
          facets: [
            {
              index: {
                byteStart: 5,
                byteEnd: new TextEncoder().encode(text).length,
              },
              features: [
                {
                  $type: "app.bsky.richtext.facet#link",
                  uri: "https://example.com/piece",
                },
              ],
            },
          ],
          embed: {
            external: { uri: "https://example.com/piece", title: "A piece" },
          },
        }),
      ),
    );
    expect(duplicated.blocks).toEqual([]);
  });

  it("reports a video rather than dropping it in silence", () => {
    const { blocks, video } = embedMarkdown(
      withEmbed({ $type: "app.bsky.embed.video#view", playlist: "https://x" }),
    );
    expect(blocks).toEqual([]);
    expect(video).toBe(true);
  });

  it("unwraps recordWithMedia into both halves", () => {
    const { blocks } = embedMarkdown(
      withEmbed({
        $type: "app.bsky.embed.recordWithMedia#view",
        media: {
          images: [
            { fullsize: "https://cdn.bsky.app/img/z.jpg", alt: "chart" },
          ],
        },
        record: {
          record: {
            uri: uri(THEM, "3m5"),
            author: { did: THEM, handle: "them.example" },
          },
        },
      }),
    );
    expect(blocks).toEqual([
      "![chart](https://cdn.bsky.app/img/z.jpg)",
      "Quoting [@them.example](https://bsky.app/profile/them.example/post/3m5)",
    ]);
  });
});

// ----------------------------------------------------------------- assembly

describe("assembleThread", () => {
  const ROOT = uri(ME, "3n1");

  function threadOf(...texts: string[]) {
    // Nest each post as the previous one's reply, oldest outermost.
    let deepest = node(
      postView({
        rkey: `3n${texts.length}`,
        text: texts[texts.length - 1],
        parent: uri(ME, `3n${texts.length - 1}`),
        createdAt: `2026-02-04T10:0${texts.length}:00.000Z`,
      }),
    );
    for (let i = texts.length - 2; i >= 1; i--) {
      deepest = node(
        postView({
          rkey: `3n${i + 1}`,
          text: texts[i],
          parent: uri(ME, `3n${i}`),
          createdAt: `2026-02-04T10:0${i + 1}:00.000Z`,
        }),
        [deepest],
      );
    }
    return {
      thread: node(postView({ rkey: "3n1", text: texts[0] }), [deepest]),
    };
  }

  it("joins the writer's own spine into one piece of prose", () => {
    const result = assembleThread(threadOf("On leaving", "second", "third"), {
      rootUri: ROOT,
      author: ME,
    });
    expect(result).not.toBeNull();
    expect(result?.markdown).toBe("On leaving\n\nsecond\n\nthird");
    expect(result?.postCount).toBe(3);
    expect(result?.title).toBe("On leaving");
    expect(result?.createdAt).toBe("2026-02-04T10:00:00.000Z");
    expect(result?.sourceUrl).toBe(`https://bsky.app/profile/${ME}/post/3n1`);
    expect(result?.truncated).toBe(false);
    // No "1/" markers, no rules between posts: it reads as what it was.
    expect(result?.markdown).not.toMatch(/---|\d+\/\d+/);
  });

  it("follows ONLY my replies past a stranger's", () => {
    const data = {
      thread: node(postView({ rkey: "3o1", text: "root" }), [
        node(
          postView({
            did: THEM,
            rkey: "3o9",
            text: "A STRANGER SPEAKING",
            parent: uri(ME, "3o1"),
            createdAt: "2026-02-04T10:00:30.000Z",
          }),
          [
            node(
              postView({
                rkey: "3o8",
                text: "me answering them",
                parent: uri(THEM, "3o9"),
              }),
            ),
          ],
        ),
        node(
          postView({
            rkey: "3o2",
            text: "my own second",
            parent: uri(ME, "3o1"),
            createdAt: "2026-02-04T10:01:00.000Z",
          }),
        ),
      ]),
    };
    const result = assembleThread(data, {
      rootUri: uri(ME, "3o1"),
      author: ME,
    });
    expect(result?.markdown).toBe("root\n\nmy own second");
    expect(result?.markdown).not.toContain("A STRANGER SPEAKING");
    // My reply UNDER the stranger's post isn't on my spine either.
    expect(result?.markdown).not.toContain("me answering them");
  });

  it("refuses a root that isn't mine", () => {
    expect(
      assembleThread(
        { thread: node(postView({ did: THEM, rkey: "3p1", text: "theirs" })) },
        { rootUri: uri(THEM, "3p1"), author: ME },
      ),
    ).toBeNull();
  });

  it("refuses a root that isn't the post we asked for", () => {
    expect(
      assembleThread(threadOf("a", "b"), {
        rootUri: uri(ME, "3zz9"),
        author: ME,
      }),
    ).toBeNull();
  });

  it("refuses a deleted or blocked root", () => {
    for (const thread of [
      { notFound: true, $type: "app.bsky.feed.defs#notFoundPost" },
      { blocked: true, $type: "app.bsky.feed.defs#blockedPost" },
    ]) {
      expect(
        assembleThread({ thread }, { rootUri: ROOT, author: ME }),
      ).toBeNull();
    }
  });

  it("refuses a lone post — the same v1 rule discovery applies", () => {
    expect(
      assembleThread(
        { thread: node(postView({ rkey: "3n1", text: "alone" })) },
        { rootUri: ROOT, author: ME },
      ),
    ).toBeNull();
  });

  it("cuts at the post cap and says so", () => {
    // A spine one longer than the cap: the cut has to be reported, not hidden.
    let deepest = node(
      postView({
        rkey: `x${MAX_THREAD_POSTS + 1}`,
        text: `post ${MAX_THREAD_POSTS + 1}`,
        parent: uri(ME, `x${MAX_THREAD_POSTS}`),
        createdAt: "2026-02-05T00:00:00.000Z",
      }),
    );
    for (let i = MAX_THREAD_POSTS; i >= 2; i--) {
      deepest = node(
        postView({
          rkey: `x${i}`,
          text: `post ${i}`,
          parent: uri(ME, `x${i - 1}`),
          createdAt: `2026-02-04T${String(i).padStart(2, "0")}:00:00.000Z`,
        }),
        [deepest],
      );
    }
    const data = {
      thread: node(postView({ rkey: "x1", text: "post 1" }), [deepest]),
    };
    const result = assembleThread(data, {
      rootUri: uri(ME, "x1"),
      author: ME,
    });
    expect(result?.postCount).toBe(MAX_THREAD_POSTS);
    expect(result?.truncated).toBe(true);
  });

  /**
   * A SPINE CUT IN THE MIDDLE IS A CUT, not an ending.
   *
   * When the writer deleted a mid-thread post — or a block hides one — the
   * AppView returns `#notFoundPost` / `#blockedPost`, which carries a uri and
   * deliberately nothing else. There is no author on it, so there is no way to
   * know whether it WAS the writer's own continuation. The spine used to walk
   * straight past it and stop, and `truncated` stayed false: an import that
   * dropped the second half of a piece while reporting it came across whole.
   *
   * Any early termination that is not a natural end-of-spine counts, so the
   * unreadable node is reported and the picker says so.
   */
  it("reports a spine stopped by a deleted post as truncated", () => {
    const data = {
      thread: node(postView({ rkey: "3d1", text: "root" }), [
        node(
          postView({
            rkey: "3d2",
            text: "second",
            parent: uri(ME, "3d1"),
            createdAt: "2026-02-04T10:01:00.000Z",
          }),
          // The writer deleted the third post; everything past it is lost.
          [{ $type: "app.bsky.feed.defs#notFoundPost", notFound: true }],
        ),
      ]),
    };
    const result = assembleThread(data, {
      rootUri: uri(ME, "3d1"),
      author: ME,
    });
    // What survived still comes across — the words are not the casualty.
    expect(result?.postCount).toBe(2);
    expect(result?.truncated).toBe(true);
  });

  it("reports a spine stopped by a blocked post as truncated", () => {
    const data = {
      thread: node(postView({ rkey: "3b1", text: "root" }), [
        node(
          postView({
            rkey: "3b2",
            text: "second",
            parent: uri(ME, "3b1"),
            createdAt: "2026-02-04T10:01:00.000Z",
          }),
          [{ $type: "app.bsky.feed.defs#blockedPost", blocked: true }],
        ),
      ]),
    };
    expect(
      assembleThread(data, { rootUri: uri(ME, "3b1"), author: ME })?.truncated,
    ).toBe(true);
  });

  it("does NOT call a thread that simply ended truncated", () => {
    // The counter-case: without it the check above could pass by marking
    // everything truncated, which would make the picker's warning meaningless.
    const result = assembleThread(threadOf("root", "second", "third"), {
      rootUri: ROOT,
      author: ME,
    });
    expect(result?.postCount).toBe(3);
    expect(result?.truncated).toBe(false);
  });

  it("carries the video flag up from whichever post held it", () => {
    const data = {
      thread: node(postView({ rkey: "3q1", text: "root" }), [
        node(
          postView({
            rkey: "3q2",
            text: "with a clip",
            parent: uri(ME, "3q1"),
            embed: { $type: "app.bsky.embed.video#view" },
            createdAt: "2026-02-04T10:01:00.000Z",
          }),
        ),
      ]),
    };
    expect(
      assembleThread(data, { rootUri: uri(ME, "3q1"), author: ME })
        ?.droppedVideo,
    ).toBe(true);
  });
});

// ------------------------------------------------------------ network shape

describe("the AppView reads", () => {
  function jsonFetch(bodies: unknown[]) {
    let call = 0;
    return vi.fn(async () => {
      const body = bodies[Math.min(call++, bodies.length - 1)];
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("walks at most MAX_THREAD_DISCOVERY_PAGES pages and reports the cut", async () => {
    const fetcher = jsonFetch([
      {
        feed: [
          { post: postView({ rkey: "3r1", text: "root" }) },
          {
            post: postView({
              rkey: "3r2",
              text: "reply",
              parent: uri(ME, "3r1"),
              createdAt: "2026-02-04T10:01:00.000Z",
            }),
          },
        ],
        cursor: "more",
      },
    ]);
    const found = await discoverAuthorThreads(
      ME,
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher).toHaveBeenCalledTimes(MAX_THREAD_DISCOVERY_PAGES);
    expect(found?.truncated).toBe(true);
    expect(found?.threads).toHaveLength(1);
  });

  it("only ever talks to the fixed AppView host, with the session's own actor", async () => {
    const fetcher = jsonFetch([{ feed: [], cursor: null }]);
    await discoverAuthorThreads(ME, fetcher as unknown as typeof fetch);
    const url = new URL((fetcher.mock.calls[0] as unknown as [string])[0]);
    expect(url.host).toBe("public.api.bsky.app");
    expect(url.pathname).toBe("/xrpc/app.bsky.feed.getAuthorFeed");
    expect(url.searchParams.get("actor")).toBe(ME);
    expect(url.searchParams.get("filter")).toBe("posts_with_replies");
  });

  it("reports unavailable when the FIRST page fails, and keeps a partial walk", async () => {
    const dead = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(
      (await discoverAuthorThreads(ME, dead as unknown as typeof fetch))
        ?.unavailable,
    ).toBe(true);

    let call = 0;
    const flaky = vi.fn(async () => {
      call++;
      if (call === 1)
        return new Response(
          JSON.stringify({
            feed: [
              { post: postView({ rkey: "3s1", text: "root" }) },
              {
                post: postView({
                  rkey: "3s2",
                  text: "reply",
                  parent: uri(ME, "3s1"),
                  createdAt: "2026-02-04T10:01:00.000Z",
                }),
              },
            ],
            cursor: "more",
          }),
        );
      return new Response("nope", { status: 500 });
    });
    const partial = await discoverAuthorThreads(
      ME,
      flaky as unknown as typeof fetch,
    );
    expect(partial?.unavailable).toBe(false);
    expect(partial?.threads).toHaveLength(1);
  });

  it("refuses an oversized body rather than parsing it", async () => {
    const huge = vi.fn(
      async () =>
        new Response("x".repeat(MAX_THREAD_RESPONSE_BYTES + 1024), {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      (await discoverAuthorThreads(ME, huge as unknown as typeof fetch))
        ?.unavailable,
    ).toBe(true);
  });

  it("drops an over-long upstream cursor instead of echoing it back", async () => {
    const fetcher = jsonFetch([{ feed: [], cursor: "c".repeat(600) }]);
    await discoverAuthorThreads(ME, fetcher as unknown as typeof fetch);
    // A rejected cursor ends the walk, so exactly one call went out.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
