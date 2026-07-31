// @vitest-environment node

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

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
    // Third-party publication surfaces are never enumerated (unbounded).
    expect(locs.join(" ")).not.toContain("/@");
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
