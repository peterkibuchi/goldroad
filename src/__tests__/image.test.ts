// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fitWithin, MAX_COVER_DIMENSION } from "../lib/image";

/** The canvas encode loop is browser-only (verified by screenshot evidence);
 * the sizing math it depends on is pinned here. */
describe("fitWithin", () => {
  it("never upscales", () => {
    expect(fitWithin(800, 600, MAX_COVER_DIMENSION)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("scales the longest side down to maxDim, preserving aspect", () => {
    expect(fitWithin(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitWithin(1600, 3200, 1600)).toEqual({ width: 800, height: 1600 });
  });

  it("rounds to integers (canvas dimensions)", () => {
    const { width, height } = fitWithin(3001, 1999, 1600);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1600);
  });

  it("never returns a zero dimension, even for degenerate inputs", () => {
    expect(fitWithin(10_000, 1, 100).height).toBeGreaterThanOrEqual(1);
    expect(fitWithin(0, 0, 100)).toEqual({ width: 1, height: 1 });
  });
});
