// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formerHandleRedirect,
  formerHandleTarget,
  recordWriterHandle,
} from "../lib/handle-history";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const WRITER = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

/** The handle_history migration, run on an in-memory SQLite behind just
 * enough of the D1 interface for drizzle. */
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../../drizzle/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    if (sql.includes("`handle_history`")) sqlite.exec(sql);
  }
  const d1 = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: unknown[] = [];
      const bound = {
        bind(...values: unknown[]) {
          args = values;
          return bound;
        },
        async all() {
          // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
          return { results: statement.all(...(args as any[])), success: true };
        },
        async run() {
          // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
          statement.run(...(args as any[]));
          return { results: [], success: true, meta: {} };
        },
        async raw() {
          statement.setReturnArrays(true);
          // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
          return statement.all(...(args as any[]));
        },
      };
      return bound;
    },
  };
  return { sqlite, db: drizzle(d1 as never) };
}

/** Identity on the network: which DID each handle resolves to, and which
 * handle each DID document claims. */
function network(
  handles: Record<string, string>,
  claims: Record<string, string>,
  { plcDown = false } = {},
) {
  const fn = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.hostname === "public.api.bsky.app") {
      const did = handles[url.searchParams.get("handle") ?? ""];
      return did
        ? new Response(JSON.stringify({ did }))
        : new Response("{}", { status: 400 });
    }
    if (url.hostname === "plc.directory") {
      if (plcDown) return new Response("{}", { status: 503 });
      const did = url.pathname.slice(1);
      return new Response(
        JSON.stringify({
          alsoKnownAs: claims[did] ? [`at://${claims[did]}`] : [],
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example",
            },
          ],
        }),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recordWriterHandle", () => {
  it("records a handle that resolves back to the writer, lowercased", async () => {
    const { db, sqlite } = freshDb();
    network({ "Alice.Example": WRITER }, {});
    await recordWriterHandle(db, WRITER, "Alice.Example");
    expect(
      sqlite.prepare("select handle, did from handle_history").all(),
    ).toEqual([{ handle: "alice.example", did: WRITER }]);
  });

  it("ignores a handle the writer merely claims", async () => {
    // Someone else's DID document says "victim.example"; it resolves elsewhere.
    const { db, sqlite } = freshDb();
    network({ "victim.example": OTHER }, {});
    await recordWriterHandle(db, WRITER, "victim.example");
    expect(sqlite.prepare("select * from handle_history").all()).toEqual([]);
  });

  it("costs no lookup when the handle is already recorded", async () => {
    const { db } = freshDb();
    network({ "alice.example": WRITER }, {});
    await recordWriterHandle(db, WRITER, "alice.example");
    const fetches = network({ "alice.example": WRITER }, {});
    await recordWriterHandle(db, WRITER, "alice.example");
    expect(fetches).not.toHaveBeenCalled();
  });

  it("hands a reused handle to its latest owner", async () => {
    const { db, sqlite } = freshDb();
    network({ "alice.example": WRITER }, {});
    await recordWriterHandle(db, WRITER, "alice.example");
    network({ "alice.example": OTHER }, {});
    await recordWriterHandle(db, OTHER, "alice.example");
    expect(sqlite.prepare("select did from handle_history").all()).toEqual([
      { did: OTHER },
    ]);
  });
});

describe("formerHandleTarget", () => {
  async function seeded() {
    const { db } = freshDb();
    network({ "alice.example": WRITER }, {});
    await recordWriterHandle(db, WRITER, "alice.example");
    return db;
  }

  it("points an old handle at the writer's verified current one, for good", async () => {
    const db = await seeded();
    network({ "alice.com": WRITER }, { [WRITER]: "alice.com" });
    expect(await formerHandleTarget(db, "Alice.Example")).toEqual({
      ident: "alice.com",
      permanent: true,
    });
  });

  it("remembers the new handle too, so a second move still resolves", async () => {
    const db = await seeded();
    network({ "alice.com": WRITER }, { [WRITER]: "alice.com" });
    await formerHandleTarget(db, "alice.example");
    network({ "alice.net": WRITER }, { [WRITER]: "alice.net" });
    expect(await formerHandleTarget(db, "alice.com")).toEqual({
      ident: "alice.net",
      permanent: true,
    });
  });

  it("falls back to the DID, not permanently, when the current handle doesn't verify", async () => {
    const db = await seeded();
    network({ "alice.com": OTHER }, { [WRITER]: "alice.com" });
    expect(await formerHandleTarget(db, "alice.example")).toEqual({
      ident: WRITER,
      permanent: false,
    });
  });

  it("doesn't redirect while the writer still claims the handle", async () => {
    // Resolution failed for another reason; a redirect would outlive it.
    const db = await seeded();
    network({}, { [WRITER]: "alice.example" });
    expect(await formerHandleTarget(db, "alice.example")).toBeNull();
  });

  it("doesn't redirect when the writer's DID document can't be read", async () => {
    const db = await seeded();
    network({}, {}, { plcDown: true });
    expect(await formerHandleTarget(db, "alice.example")).toBeNull();
  });

  it("doesn't redirect a handle it never saw", async () => {
    const db = await seeded();
    network({ "alice.com": WRITER }, { [WRITER]: "alice.com" });
    expect(await formerHandleTarget(db, "bob.example")).toBeNull();
  });
});

describe("formerHandleRedirect", () => {
  it("301s to a verified handle with a bounded lifetime, 302s to a DID", () => {
    expect(
      formerHandleRedirect({ ident: "alice.com", permanent: true }, "/3abc"),
    ).toEqual({
      href: "/@alice.com/3abc",
      statusCode: 301,
      headers: { "cache-control": "public, max-age=86400" },
    });
    expect(
      formerHandleRedirect({ ident: WRITER, permanent: false }, "/rss.xml"),
    ).toMatchObject({
      href: `/@${encodeURIComponent(WRITER)}/rss.xml`,
      statusCode: 302,
    });
  });
});
