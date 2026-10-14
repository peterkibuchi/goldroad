// @vitest-environment node
/**
 * Post search against real SQLite FTS5, with every migration applied: the
 * index, the triggers that keep it in step with `search_documents`, and the
 * queries the archive runs. What these pin is what a reader relies on: every
 * word a writer published is findable, an edit or delete is reflected at
 * once, another writer's posts never answer, and nothing a reader types can
 * break the query.
 */
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";

import { markdownContent } from "../lib/document-content";
import {
  deleteSearchBackfillForDid,
  deleteSearchDocumentsForDid,
} from "../lib/rights-store";
import {
  backfillStep,
  indexDocument,
  isSearchReady,
  runPublicationSearch,
  SEARCH_RESULT_LIMIT,
  searchPosts,
  unindexDocument,
} from "../lib/search";
import { HIT_CLOSE, HIT_OPEN, toMatchExpression } from "../lib/search-query";
import { type SqliteD1, sqliteD1 } from "./support/sqlite-d1";

const ME = "did:plc:fake2222222222writer2222";
const THEM = "did:plc:fake3333333333reader3333";

let d1: SqliteD1;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  d1 = sqliteD1();
  db = drizzle(d1);
});

/** A document as the publish path builds it: markpub content plus its
 * plaintext projection. */
function post(
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
) {
  return {
    title,
    content: markdownContent(body),
    textContent: body,
    publishedAt: "2026-09-30T10:00:00.000Z",
    ...extra,
  };
}

async function find(q: string, did = ME) {
  const match = toMatchExpression(q);
  if (!match) throw new Error("query has no words");
  return searchPosts(db, did, match);
}

function markComplete(did = ME) {
  d1.sqlite
    .prepare(
      "insert into search_backfills (did, completed_at, updated_at) values (?, 1, 1)",
    )
    .run(did);
}

describe("the index", () => {
  it("finds a post by a word in its body, and marks where", async () => {
    await indexDocument(
      db,
      ME,
      "3ma",
      post("Notes from a garden", "Tomatoes need patience and warm soil."),
    );
    const [hit] = await find("patience");
    expect(hit.rkey).toBe("3ma");
    expect(hit.snippet).toContain(`${HIT_OPEN}patience${HIT_CLOSE}`);
  });

  it("matches word forms and accents a reader wouldn't type exactly", async () => {
    await indexDocument(
      db,
      ME,
      "3ma",
      post("Running the café", "Notes on gardening."),
    );
    // Every word is a prefix: "garden" finds "gardening", and a half-typed
    // word finds its full form.
    expect(await find("garden")).toHaveLength(1);
    expect(await find("runn")).toHaveLength(1);
    expect(await find("cafe")).toHaveLength(1);
    expect(await find("CAFÉ")).toHaveLength(1);
  });

  it("ranks a title match above a body mention", async () => {
    await indexDocument(db, ME, "3mbody", post("Elsewhere", "a word on soil"));
    await indexDocument(db, ME, "3mtitle", post("On soil", "other things"));
    const hits = await find("soil");
    expect(hits.map((h) => h.rkey)).toEqual(["3mtitle", "3mbody"]);
    expect(hits[0].title).toBe(`On ${HIT_OPEN}soil${HIT_CLOSE}`);
  });

  it("an edit replaces the old words rather than adding to them", async () => {
    await indexDocument(db, ME, "3ma", post("Draft", "about tomatoes"));
    await indexDocument(db, ME, "3ma", post("Draft", "about cucumbers"));
    expect(await find("tomatoes")).toEqual([]);
    expect(await find("cucumbers")).toHaveLength(1);
  });

  it("a deleted post stops answering", async () => {
    await indexDocument(db, ME, "3ma", post("Gone", "ephemeral words"));
    await unindexDocument(db, ME, "3ma");
    expect(await find("ephemeral")).toEqual([]);
  });

  it("only answers for the writer whose archive is being searched", async () => {
    await indexDocument(db, THEM, "3mx", post("Theirs", "shared word"));
    await indexDocument(db, ME, "3my", post("Mine", "shared word"));
    expect((await find("shared")).map((h) => h.rkey)).toEqual(["3my"]);
  });

  it("finds another app's post by its title, but not by a body it can't read", async () => {
    const foreign = {
      title: "Made elsewhere",
      description: "a summary",
      content: { $type: "pub.leaflet.content", pages: [] },
      textContent: "leaflet words",
    };
    await indexDocument(db, ME, "3ma", foreign);
    expect(await find("elsewhere")).toHaveLength(1);
    expect(await find("summary")).toHaveLength(1);
    expect(await find("leaflet")).toEqual([]);

    // A post edited into another format keeps its title, loses its body.
    await indexDocument(db, ME, "3mb", post("Ours", "kept words"));
    await indexDocument(db, ME, "3mb", { ...foreign, title: "Ours" });
    expect(await find("kept")).toEqual([]);
    expect(await find("ours")).toHaveLength(1);
  });

  it("never lets a query word reach the writer token", async () => {
    await indexDocument(db, ME, "3ma", post("Title", "words"));
    // Every owner token starts with "o" and hex; a word shaped like one must
    // not match every post this writer has.
    expect(await find("o646964")).toEqual([]);
  });

  it("reads plaintext out of a record that keeps markdown", async () => {
    // Older records carry markdown in textContent and no union.
    await indexDocument(db, ME, "3ma", {
      title: "Links",
      textContent: "See [the guide](https://example.com/zebra) for more.",
    });
    expect(await find("guide")).toHaveLength(1);
    // Brackets and parentheses are gone; the text matches as prose.
    const [hit] = await find("guide");
    expect(hit.snippet).not.toContain("[");
  });

  it("can't be made to fake a highlight", async () => {
    await indexDocument(
      db,
      ME,
      "3ma",
      post("Title", `plain ${HIT_OPEN}fake${HIT_CLOSE} words`),
    );
    const [hit] = await find("plain");
    expect(hit.snippet).not.toContain(`${HIT_OPEN}fake`);
  });

  it("survives whatever a reader types", async () => {
    await indexDocument(db, ME, "3ma", post("Title", "ordinary words"));
    for (const q of [
      '"',
      'ordinary"',
      "NOT ordinary",
      "title:ordinary",
      "ordinary*)",
      "(",
      "ordinary AND OR NEAR",
      "^ordinary",
    ]) {
      const match = toMatchExpression(q);
      if (match)
        await expect(searchPosts(db, ME, match)).resolves.toBeDefined();
    }
    // "NOT" is a word here, not an operator, so it narrows instead of inverting.
    expect(await find("NOT ordinary")).toEqual([]);
    expect(await find("ordinary")).toHaveLength(1);
  });

  it("account deletion takes the writer's index and backfill state", async () => {
    await indexDocument(db, ME, "3ma", post("Mine", "private-ish words"));
    await indexDocument(db, THEM, "3mb", post("Theirs", "private-ish words"));
    markComplete();
    await deleteSearchDocumentsForDid(db, ME);
    await deleteSearchBackfillForDid(db, ME);
    expect(await find("words")).toEqual([]);
    expect(await find("words", THEM)).toHaveLength(1);
    expect(await isSearchReady(db, ME)).toBe(false);
  });
});

describe("backfill", () => {
  const record = (rkey: string, value: Record<string, unknown>) => ({
    uri: `at://${ME}/site.standard.document/${rkey}`,
    value,
  });

  it("walks the repo page by page, and search waits until it's done", async () => {
    const pages: Record<
      string,
      { records: ReturnType<typeof record>[]; cursor: string | null }
    > = {
      start: { records: [record("3ma", post("First", "alpha"))], cursor: "c1" },
      c1: { records: [record("3mb", post("Second", "beta"))], cursor: null },
    };
    const asked: (string | undefined)[] = [];
    const readPage = async (cursor: string | undefined) => {
      asked.push(cursor);
      return pages[cursor ?? "start"];
    };

    expect(await backfillStep(db, ME, readPage)).toEqual({
      done: false,
      indexed: 1,
    });
    expect(await isSearchReady(db, ME)).toBe(false);
    expect((await runPublicationSearch(db, ME, "alpha")).ready).toBe(false);

    expect(await backfillStep(db, ME, readPage)).toEqual({
      done: true,
      indexed: 1,
    });
    expect(asked).toEqual([undefined, "c1"]);
    expect(await isSearchReady(db, ME)).toBe(true);

    // Done means done: no more reads.
    expect(await backfillStep(db, ME, readPage)).toEqual({
      done: true,
      indexed: 0,
    });
    expect(asked).toHaveLength(2);
    const result = await runPublicationSearch(db, ME, "beta");
    expect(result.ready && result.hits.map((h) => h.rkey)).toEqual(["3mb"]);
  });

  it("skips what it shouldn't index and keeps going", async () => {
    const step = await backfillStep(db, ME, async () => ({
      records: [
        record("3ma", { title: "", textContent: "untitled" }),
        record("3mb", {
          title: "Elsewhere",
          content: { $type: "pub.leaflet.content" },
        }),
        { uri: "not-a-uri", value: post("Odd", "words") },
        record("3mc", post("Kept", "gamma")),
      ],
      cursor: null,
    }));
    // The other app's post comes in by title; the untitled and the malformed don't.
    expect(step).toEqual({ done: true, indexed: 2 });
  });
});

describe("backfill — racing the writer", () => {
  it("never overwrites a post that was edited after its page was read", async () => {
    await indexDocument(db, ME, "3ma", post("Edited", "newer words"));
    await backfillStep(db, ME, async () => ({
      records: [
        {
          uri: `at://${ME}/site.standard.document/3ma`,
          value: post("Original", "older words"),
        },
      ],
      cursor: null,
    }));
    expect(await find("newer")).toHaveLength(1);
    expect(await find("older")).toEqual([]);
  });

  it("can't be marked unfinished by a slower tab", async () => {
    await backfillStep(db, ME, async () => {
      // Another tab finishes the walk while this one is still reading a page.
      await backfillStep(db, ME, async () => ({ records: [], cursor: null }));
      return { records: [], cursor: "c1" };
    });
    expect(await isSearchReady(db, ME)).toBe(true);
  });
});

describe("runPublicationSearch", () => {
  it("answers nothing for a writer who has been taken down", async () => {
    markComplete();
    await indexDocument(db, ME, "3ma", post("Fine", "common word"));
    d1.sqlite
      .prepare("insert into hidden_content (subject, created_at) values (?, 1)")
      .run(ME);
    expect(await runPublicationSearch(db, ME, "common")).toEqual({
      ready: true,
      hits: [],
      more: false,
    });
  });

  it("leaves out a post that has been taken down", async () => {
    markComplete();
    await indexDocument(db, ME, "3ma", post("Fine", "common word"));
    await indexDocument(db, ME, "3mb", post("Hidden", "common word"));
    d1.sqlite
      .prepare("insert into hidden_content (subject, created_at) values (?, 1)")
      .run(`at://${ME}/site.standard.document/3mb`);
    const result = await runPublicationSearch(db, ME, "common");
    expect(result.ready && result.hits.map((h) => h.rkey)).toEqual(["3ma"]);
  });

  it("doesn't let hidden matches use up the page", async () => {
    markComplete();
    // The best matches are all taken down; the one visible post ranks last.
    for (let i = 0; i < SEARCH_RESULT_LIMIT + 2; i++) {
      await indexDocument(db, ME, `3mh${i}`, post("common common", "x"));
      d1.sqlite
        .prepare(
          "insert into hidden_content (subject, created_at) values (?, 1)",
        )
        .run(`at://${ME}/site.standard.document/3mh${i}`);
    }
    await indexDocument(db, ME, "3mv", post("Visible", "common"));
    const result = await runPublicationSearch(db, ME, "common");
    expect(result.ready && result.hits.map((h) => h.rkey)).toEqual(["3mv"]);
    expect(result.ready && result.more).toBe(false);
  });

  it("shows a page of results and says there are more", async () => {
    markComplete();
    for (let i = 0; i < SEARCH_RESULT_LIMIT + 3; i++)
      await indexDocument(db, ME, `3m${i}`, post(`Post ${i}`, "repeated"));
    const result = await runPublicationSearch(db, ME, "repeated");
    if (!result.ready) throw new Error("expected results");
    expect(result.hits).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(result.more).toBe(true);
  });

  it("isn't ready for a query with no words in it", async () => {
    markComplete();
    expect((await runPublicationSearch(db, ME, "*** ???")).ready).toBe(false);
  });

  it("falls back rather than failing when the database does", async () => {
    markComplete();
    d1.sqlite.exec("drop table post_search");
    const quiet = console.error;
    console.error = () => {};
    try {
      expect((await runPublicationSearch(db, ME, "anything")).ready).toBe(
        false,
      );
    } finally {
      console.error = quiet;
    }
  });
});
