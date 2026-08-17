/**
 * The installed-app icon set, checked against the manifest that advertises it.
 *
 * The manifest is a set of promises about files: this size, that purpose, at
 * that path. Nothing in the build checks those promises, and the failure is
 * quiet on the way out — a wrong `sizes` or a dangling `src` costs you the
 * Home Screen icon on some platforms and nothing at all on others, so it ships
 * looking fine. Worse, for a while every slot here pointed at the same square
 * artwork, including the one the manifest calls `maskable`, which is the one
 * slot where the artwork genuinely has to be different: Android crops maskable
 * icons to a circle or a squircle, so a mark drawn to the edges loses its
 * corners. These tests pin what the manifest says to what is on disk.
 */

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
};

const publicDir = join(import.meta.dirname, "..", "..", "public");
const read = (src: string) => readFileSync(join(publicDir, src));

const manifest = JSON.parse(
  readFileSync(join(publicDir, "manifest.json"), "utf8"),
) as { icons: ManifestIcon[] };

/** Every size a `sizes` string claims, as numbers. It can list several. */
const declaredSizes = (sizes: string): number[] =>
  sizes.split(/\s+/).map((pair) => Number(pair.split("x")[0]));

/** PNG IHDR: 8-byte signature, 4-byte length, 4-byte type, then width/height
 * as big-endian uint32s — the same read the share-card test does. */
const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

/** An .ico is a 6-byte header (the image count at offset 4) followed by 16-byte
 * directory entries whose first two bytes are width and height, with 0 meaning
 * 256 — the one dimension a single byte cannot hold. */
const icoSizes = (ico: Buffer): number[] => {
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256);
};

/** Narrows away an optional and fails loudly if the thing it looked for is
 * missing, so a lookup that comes back empty reports itself instead of
 * quietly turning the assertion after it into a comparison of undefineds. */
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`no ${what} to check`);
  return value;
};

const pngIcons = manifest.icons.filter((icon) => icon.type === "image/png");

describe("the manifest's icons exist and are the size it claims", () => {
  it("lists at least one PNG icon, so the loops below can fail", () => {
    expect(pngIcons.length).toBeGreaterThan(0);
  });

  for (const icon of manifest.icons) {
    it(`${icon.src} is on disk`, () => {
      expect(() => read(icon.src)).not.toThrow();
    });
  }

  for (const icon of pngIcons) {
    it(`${icon.src} really is ${icon.sizes}`, () => {
      const [size] = declaredSizes(icon.sizes);
      expect(pngSize(read(icon.src))).toEqual({ width: size, height: size });
    });
  }
});

describe("the maskable slot carries its own artwork", () => {
  const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
  const any = manifest.icons.filter((i) => i.purpose === "any");

  /** `purpose: "any maskable"` on one file is the shortcut that loses the
   * corners on Android and the padding everywhere else. Two files, two jobs. */
  it("declares maskable and any as separate entries", () => {
    expect(maskable).toHaveLength(1);
    expect(any.length).toBeGreaterThan(0);
    for (const icon of manifest.icons)
      expect(icon.purpose ?? "any").not.toContain(" ");
  });

  it("does not point the maskable slot at the full-bleed artwork", () => {
    const inset = must(maskable[0], "maskable icon");
    const sameSize = must(
      any.find(
        (i) => declaredSizes(i.sizes)[0] === declaredSizes(inset.sizes)[0],
      ),
      "same-size 'any' icon to compare against",
    );
    // Byte equality is the check that catches the copy: a real maskable render
    // insets the mark into the safe zone, so it cannot be the same file.
    expect(read(inset.src).equals(read(sameSize.src))).toBe(false);
  });
});

describe("the favicon", () => {
  it("contains every size the manifest advertises", () => {
    const entry = must(
      manifest.icons.find((i) => i.src.endsWith(".ico")),
      ".ico entry in the manifest",
    );
    const ico = read(entry.src);
    expect(ico.readUInt16LE(2), "ICO type field").toBe(1);
    // Both directions: no advertised size missing, no stowaway size unlisted.
    expect(icoSizes(ico).sort((a, b) => a - b)).toEqual(
      declaredSizes(entry.sizes).sort((a, b) => a - b),
    );
  });
});

/** iOS ignores the manifest for the Home Screen and asks for this file by name
 * at 180×180, so it is the one icon no manifest test would have covered. */
describe("the apple-touch icon", () => {
  it("is the 180×180 iOS asks for", () => {
    expect(pngSize(read("apple-touch-icon.png"))).toEqual({
      width: 180,
      height: 180,
    });
  });
});
