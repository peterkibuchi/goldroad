// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  MAX_SITEMAP_PUBLICATIONS,
  recordHostedPublication,
  selectSitemapPublications,
  sitemapPublicationUrl,
} from "../lib/hosted-publications";

// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);

describe("hosted publications — the sitemap's list", () => {
  it("keeps one row per writer, updated on every publish", () => {
    const { sql, params } = recordHostedPublication(
      db,
      "did:plc:fake2222222222writer2222",
      "https://trygoldroad.com/@writer.example",
    ).toSQL();
    expect(sql.toLowerCase()).toContain('insert into "hosted_publications"');
    expect(sql).toContain(
      'on conflict ("hosted_publications"."did") do update',
    );
    expect(params).toContain("https://trygoldroad.com/@writer.example");
  });

  it("leaves out writers on the takedown list, newest first, bounded", () => {
    const { sql, params } = selectSitemapPublications(db).toSQL();
    expect(sql).toMatch(
      /"did" not in \(select "hidden_content"."subject" from "hidden_content"\)/,
    );
    expect(sql).toContain('order by "hosted_publications"."updated_at" desc');
    expect(params).toContain(MAX_SITEMAP_PUBLICATIONS);
  });

  it("lists only our own publication pages, on the canonical origin", () => {
    expect(
      sitemapPublicationUrl("https://trygoldroad.com/@writer.example"),
    ).toBe("https://trygoldroad.com/@writer.example");
    expect(
      sitemapPublicationUrl(
        "https://goldroad.kibuchi.workers.dev/@early.example?x=1",
      ),
    ).toBe("https://trygoldroad.com/@early.example");
    expect(sitemapPublicationUrl("https://writer.leaflet.pub")).toBeNull();
    expect(sitemapPublicationUrl("https://trygoldroad.com.evil/@x")).toBeNull();
  });
});
