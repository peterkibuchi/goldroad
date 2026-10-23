// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_SITEMAP_PUBLICATIONS,
  noteHostedPublication,
  selectSitemapPublications,
  sitemapPublicationUrl,
} from "../lib/hosted-publications";
import { sqliteD1 } from "./support/sqlite-d1";

const WRITER = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const HIDDEN = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const PUB = `at://${WRITER}/site.standard.publication/3lyk73wxnok2f`;

/** A fresh database with every migration applied (the real schema). */
const freshDb = () => {
  const d1 = sqliteD1();
  return { d1, db: drizzle(d1) };
};

describe("noteHostedPublication", () => {
  it("keeps one row per writer, moved to the latest publish and ident", async () => {
    const { db } = freshDb();
    await noteHostedPublication(db, WRITER, "old.example", PUB);
    await noteHostedPublication(db, WRITER, "writer.example", PUB);
    const rows = await selectSitemapPublications(db);
    expect(rows.map((row) => row.ident)).toEqual(["writer.example"]);
  });

  it("notes nothing for a post outside a publication of ours, or a bad ident", async () => {
    const { db } = freshDb();
    // resolvePublicationSite's https fallback: no publication record of ours.
    await noteHostedPublication(
      db,
      WRITER,
      "writer.example",
      "https://x.example",
    );
    await noteHostedPublication(db, WRITER, "not a handle", PUB);
    expect(await selectSitemapPublications(db)).toEqual([]);
  });

  it("swallows a database failure", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    const broken = drizzle(failing);
    await expect(
      noteHostedPublication(broken, WRITER, "writer.example", PUB),
    ).resolves.toBeUndefined();
    quiet.mockRestore();
  });
});

describe("selectSitemapPublications", () => {
  it("leaves out a writer on the takedown list, newest publish first", async () => {
    const { d1, db } = freshDb();
    await noteHostedPublication(db, WRITER, "writer.example", PUB);
    await noteHostedPublication(db, HIDDEN, "hidden.example", PUB);
    d1.sqlite
      .prepare("insert into hidden_content (subject, created_at) values (?, ?)")
      .run(HIDDEN, 0);
    const rows = await selectSitemapPublications(db);
    expect(rows.map((row) => row.ident)).toEqual(["writer.example"]);
  });

  it("reads at most the sitemap's bound", () => {
    const { db } = freshDb();
    const { params } = selectSitemapPublications(db).toSQL();
    expect(params).toContain(MAX_SITEMAP_PUBLICATIONS);
  });
});

describe("sitemapPublicationUrl", () => {
  it("builds the page from the ident alone, on the canonical origin", () => {
    expect(sitemapPublicationUrl("writer.example")).toBe(
      "https://trygoldroad.com/@writer.example",
    );
    expect(sitemapPublicationUrl(WRITER)).toBe(
      `https://trygoldroad.com/@${encodeURIComponent(WRITER)}`,
    );
    for (const bad of ["", "../api", "x/../../api", "a b.example"])
      expect(sitemapPublicationUrl(bad), bad).toBeNull();
  });
});
