// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * File-upload format detection: the single /import upload widget now
 * accepts a Substack or Medium zip, a Ghost JSON export, or a WordPress WXR
 * XML export — this pins the extension/MIME sniff and the zip-variant
 * disambiguation that decides which parser gets the bytes.
 */
import { detectFileKind, detectZipVariant } from "../lib/import-formats";

function file(name: string, type = ""): File {
  return new File(["x"], name, { type });
}

describe("detectFileKind", () => {
  it("reads the extension first", () => {
    expect(detectFileKind(file("export.zip"))).toBe("zip");
    expect(detectFileKind(file("export.json"))).toBe("json");
    expect(detectFileKind(file("export.xml"))).toBe("xml");
    expect(detectFileKind(file("EXPORT.ZIP"))).toBe("zip");
  });

  it("falls back to MIME type when the extension is missing or stripped", () => {
    expect(detectFileKind(file("export", "application/json"))).toBe("json");
    expect(detectFileKind(file("export", "text/xml"))).toBe("xml");
    expect(detectFileKind(file("export", "application/xml"))).toBe("xml");
    expect(detectFileKind(file("export", "application/zip"))).toBe("zip");
  });

  it("is honest about anything else", () => {
    expect(detectFileKind(file("export.csv", "text/csv"))).toBe("unsupported");
    expect(detectFileKind(file("export"))).toBe("unsupported");
  });
});

describe("detectZipVariant", () => {
  it("recognizes a Substack export by its posts.csv", () => {
    expect(detectZipVariant(["posts.csv", "posts/101.first-post.html"])).toBe(
      "substack",
    );
  });

  it("recognizes a Substack export by the numeric-id.slug.html pattern even without the csv", () => {
    expect(detectZipVariant(["posts/101.first-post.html"])).toBe("substack");
  });

  it("recognizes a Medium export by its loose posts/*.html files", () => {
    expect(
      detectZipVariant(["posts/2024-01-02_my-post-a1b2c3d4e5f6.html"]),
    ).toBe("medium");
    expect(detectZipVariant(["posts/draft_my-post-a1b2c3d4e5f6.html"])).toBe(
      "medium",
    );
  });

  it("prefers the Substack signature when both patterns somehow match", () => {
    expect(
      detectZipVariant(["posts.csv", "posts/my-post-a1b2c3d4e5f6.html"]),
    ).toBe("substack");
  });

  it("is unknown for anything else", () => {
    expect(detectZipVariant(["readme.txt", "images/cover.png"])).toBe(
      "unknown",
    );
    expect(detectZipVariant([])).toBe("unknown");
  });
});
