/**
 * The default share card and the pages that show it.
 *
 * The root head defaults the og:image and deliberately not its dimensions or
 * alt text: a page with a cover of its own overrides the image but cannot remove
 * sibling tags, so an inherited alt would describe a picture that isn't there.
 * The consequence is that describing the default is each relying page's job —
 * and for a while no page did it, so every marketing link shared an image with
 * no alt text at all and no dimensions for the card to reserve space with.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CARD_META } from "../lib/social-card";
import { Route as LandingRoute } from "../routes/index";
import { Route as LeavingSubstackRoute } from "../routes/leaving-substack";
import { Route as OpenRoute } from "../routes/open";

type Meta = { property?: string; name?: string; content?: string };
type HeadRoute = { options: { head: () => { meta: Meta[] } } };

const PAGES: Record<string, HeadRoute> = {
  "/": LandingRoute as unknown as HeadRoute,
  "/leaving-substack": LeavingSubstackRoute as unknown as HeadRoute,
  "/open": OpenRoute as unknown as HeadRoute,
};

const meta = (route: HeadRoute): Meta[] => route.options.head().meta;
const tag = (route: HeadRoute, property: string): Meta | undefined =>
  meta(route).find((entry) => entry.property === property);

describe("pages that share the default card describe it", () => {
  for (const [path, route] of Object.entries(PAGES)) {
    it(`${path} carries the default card's alt text and dimensions`, () => {
      expect(tag(route, "og:image:alt")?.content, path).toBeTruthy();
      expect(tag(route, "og:image:width")?.content, path).toBe("1200");
      expect(tag(route, "og:image:height")?.content, path).toBe("630");
    });

    // One description of one image: if a page ever grows its own og:image, its
    // description has to be its own too, and this is where that shows up.
    it(`${path} says the same thing about it as every other page`, () => {
      expect(tag(route, "og:image"), path).toBeUndefined();
      for (const entry of DEFAULT_CARD_META)
        expect(meta(route), path).toContainEqual(entry);
    });
  }
});

/** 1200×630 is the card aspect every consumer crops to, and these numbers are
 * a promise about a real file — they were wrong nowhere yet, and this is what
 * keeps it that way when og.png is next redrawn. */
describe("the dimensions match the image on disk", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  it("reads 1200×630 out of public/og.png", () => {
    const png = readFileSync(
      join(import.meta.dirname, "..", "..", "public", "og.png"),
    );
    // PNG IHDR: 8-byte signature, 4-byte length, 4-byte type, then width/height
    // as big-endian uint32s.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});
