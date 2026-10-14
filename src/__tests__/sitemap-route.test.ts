// @vitest-environment node

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({ selectSitemapPublications: vi.fn() }));
vi.mock("~/lib/hosted-publications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hosted-publications")>()),
  ...hosted,
}));

import { Route } from "../routes/sitemap[.]xml";
import { handlerOf } from "./support/route-handler";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GET = handlerOf(Route, "GET");

function parseXml(xml: string): Document {
  const { DOMParser } = new JSDOM("").window;
  return new DOMParser().parseFromString(
    xml,
    "text/xml",
  ) as unknown as Document;
}

const locsOf = async (res: Response) =>
  Array.from(parseXml(await res.text()).querySelectorAll("url > loc")).map(
    (el) => el.textContent,
  );

beforeEach(() => {
  hosted.selectSitemapPublications.mockReset();
  hosted.selectSitemapPublications.mockResolvedValue([]);
});

describe("/sitemap.xml", () => {
  it("serves well-formed XML with the right content type", async () => {
    const res = await GET({
      request: new Request("http://127.0.0.1:3000/sitemap.xml"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/xml; charset=utf-8",
    );
    const doc = parseXml(await res.text());
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(doc.documentElement.tagName).toBe("urlset");
  });

  it("lists exactly the first-party surfaces, minted from the canonical origin", async () => {
    const res = await GET({
      // Deliberately a NON-canonical request host: the sitemap must still
      // mint canonical-origin URLs, never echo the request origin.
      request: new Request("https://goldroad.example.workers.dev/sitemap.xml"),
    });
    const doc = parseXml(await res.text());
    const locs = Array.from(doc.querySelectorAll("url > loc")).map(
      (el) => el.textContent,
    );
    expect(locs).toEqual([
      "https://trygoldroad.com/",
      "https://trygoldroad.com/leaving-substack",
      "https://trygoldroad.com/open",
      "https://trygoldroad.com/privacy",
      "https://trygoldroad.com/terms",
      "https://trygoldroad.com/policies",
    ]);
    // With no hosted publications, no publication surface is listed.
    expect(locs.join(" ")).not.toContain("/@");
  });

  it("lists the publications hosted here, on the canonical origin, with lastmod", async () => {
    hosted.selectSitemapPublications.mockResolvedValue([
      {
        url: "https://trygoldroad.com/@writer.example",
        updatedAt: new Date("2026-10-01T09:00:00.000Z"),
      },
      // Written before the move to the canonical domain.
      {
        url: "https://goldroad.kibuchi.workers.dev/@early.example",
        updatedAt: new Date("2026-08-01T09:00:00.000Z"),
      },
      // Not ours; never listed, whatever a row says.
      {
        url: "https://writer.leaflet.pub",
        updatedAt: new Date("2026-09-01T09:00:00.000Z"),
      },
    ]);
    const res = await GET({
      request: new Request("http://127.0.0.1:3000/sitemap.xml"),
    });
    const xml = await res.clone().text();
    const locs = await locsOf(res);
    expect(locs.slice(6)).toEqual([
      "https://trygoldroad.com/@writer.example",
      "https://trygoldroad.com/@early.example",
    ]);
    expect(xml).toContain("<lastmod>2026-10-01</lastmod>");
  });

  it("still serves the first-party pages when the publication read fails", async () => {
    hosted.selectSitemapPublications.mockRejectedValue(new Error("D1 down"));
    const res = await GET({
      request: new Request("http://127.0.0.1:3000/sitemap.xml"),
    });
    expect(res.status).toBe(200);
    expect(await locsOf(res)).toHaveLength(6);
  });
});

describe("public/robots.txt", () => {
  const robots = readFileSync(
    fileURLToPath(new URL("../../public/robots.txt", import.meta.url)),
    "utf-8",
  );

  it("references the sitemap by absolute URL", () => {
    expect(robots).toContain("Sitemap: https://trygoldroad.com/sitemap.xml");
  });

  it("does not disallow any path (reading surfaces stay crawlable)", () => {
    // The only Disallow directive must be the empty allow-everything form.
    const disallows = robots
      .split("\n")
      .filter((line) => line.trim().toLowerCase().startsWith("disallow:"));
    expect(disallows).toEqual(["Disallow:"]);
  });
});
