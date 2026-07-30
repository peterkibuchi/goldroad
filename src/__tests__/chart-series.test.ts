// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  densifySeries,
  MAX_SERIES_DAYS,
  seriesSummary,
} from "../lib/chart-series";

const WINDOW = { from: "2026-07-01", to: "2026-07-05" } as const;

describe("densifySeries — an absent day means different things per series", () => {
  it("fills an absent day with a real zero for a per-day count", () => {
    // Views: the query only returns days that had events, so a day with no row
    // genuinely had no pageviews.
    expect(
      densifySeries(
        [
          { day: "2026-07-01", value: 4 },
          { day: "2026-07-04", value: 9 },
        ],
        { ...WINDOW, missing: "zero" },
      ),
    ).toEqual([
      { day: "2026-07-01", value: 4 },
      { day: "2026-07-02", value: 0 },
      { day: "2026-07-03", value: 0 },
      { day: "2026-07-04", value: 9 },
      { day: "2026-07-05", value: 0 },
    ]);
  });

  it("leaves an absent day null for a daily reading of a level", () => {
    // Followers: a day with no row means NO READING WAS TAKEN. Zero would tell
    // a writer they lost every follower that day.
    expect(
      densifySeries(
        [
          { day: "2026-07-01", value: 1200 },
          { day: "2026-07-04", value: 1240 },
        ],
        { ...WINDOW, missing: "gap" },
      ),
    ).toEqual([
      { day: "2026-07-01", value: 1200 },
      { day: "2026-07-02", value: null },
      { day: "2026-07-03", value: null },
      { day: "2026-07-04", value: 1240 },
      { day: "2026-07-05", value: null },
    ]);
  });

  it("never interpolates across a gap", () => {
    const points = densifySeries(
      [
        { day: "2026-07-01", value: 100 },
        { day: "2026-07-05", value: 200 },
      ],
      { ...WINDOW, missing: "gap" },
    );
    expect(points.filter((p) => p.value !== null)).toHaveLength(2);
    // Nothing between the endpoints carries a value at all.
    expect(points.slice(1, 4).every((p) => p.value === null)).toBe(true);
  });

  it("ignores rows outside the window and rows with an unusable value", () => {
    expect(
      densifySeries(
        [
          { day: "2026-06-30", value: 99 },
          { day: "2026-07-06", value: 99 },
          { day: "not a day", value: 5 },
          { day: "2026-07-02", value: "twelve" },
          { day: "2026-07-03", value: 7 },
        ],
        { ...WINDOW, missing: "gap" },
      ).filter((p) => p.value !== null),
    ).toEqual([{ day: "2026-07-03", value: 7 }]);
  });

  it("handles the degenerate windows without throwing", () => {
    expect(densifySeries([], { from: "x", to: "y", missing: "zero" })).toEqual(
      [],
    );
    expect(
      densifySeries([], {
        from: "2026-07-05",
        to: "2026-07-01",
        missing: "zero",
      }),
    ).toEqual([]);
    expect(
      densifySeries([{ day: "2026-07-01", value: 3 }], {
        from: "2026-07-01",
        to: "2026-07-01",
        missing: "zero",
      }),
    ).toEqual([{ day: "2026-07-01", value: 3 }]);
  });

  it("bounds the densified length, so a bad window can't hang a render", () => {
    const points = densifySeries([], {
      from: "2020-01-01",
      to: "2030-01-01",
      missing: "zero",
    });
    expect(points).toHaveLength(MAX_SERIES_DAYS);
  });
});

describe("seriesSummary — the numbers the caption and the reader summary use", () => {
  it("reports totals, net, extremes and the sampled span", () => {
    const summary = seriesSummary([
      { day: "2026-07-01", value: 10 },
      { day: "2026-07-02", value: 4 },
      { day: "2026-07-03", value: 25 },
    ]);
    expect(summary).toMatchObject({
      sampled: 3,
      missingDays: 0,
      total: 39,
      net: 15,
      lowest: { day: "2026-07-02", value: 4 },
      highest: { day: "2026-07-03", value: 25 },
      firstDay: "2026-07-01",
      lastDay: "2026-07-03",
      insufficient: false,
    });
  });

  it("counts unsampled days as missing, not as zeros", () => {
    const summary = seriesSummary([
      { day: "2026-07-01", value: 1200 },
      { day: "2026-07-02", value: null },
      { day: "2026-07-03", value: null },
      { day: "2026-07-04", value: 1240 },
    ]);
    expect(summary?.missingDays).toBe(2);
    expect(summary?.sampled).toBe(2);
    // The gap contributes nothing to the total or the extremes.
    expect(summary?.total).toBe(2440);
    expect(summary?.lowest.value).toBe(1200);
  });

  it("calls a single reading insufficient — a number, not yet a trend", () => {
    expect(
      seriesSummary([
        { day: "2026-07-01", value: 1200 },
        { day: "2026-07-02", value: null },
      ]),
    ).toMatchObject({ sampled: 1, insufficient: true, net: 0 });
  });

  it("returns null when nothing at all was sampled", () => {
    expect(seriesSummary([])).toBeNull();
    expect(
      seriesSummary([
        { day: "2026-07-01", value: null },
        { day: "2026-07-02", value: null },
      ]),
    ).toBeNull();
  });

  it("reports a real all-zero series rather than treating it as absent", () => {
    // A true flat line at zero is information, not an error.
    const summary = seriesSummary([
      { day: "2026-07-01", value: 0 },
      { day: "2026-07-02", value: 0 },
    ]);
    expect(summary).toMatchObject({
      sampled: 2,
      total: 0,
      insufficient: false,
    });
  });

  it("handles a level that went down (a writer lost followers)", () => {
    expect(
      seriesSummary([
        { day: "2026-07-01", value: 1240 },
        { day: "2026-07-02", value: 1230 },
      ]),
    ).toMatchObject({ net: -10, lowest: { value: 1230 } });
  });
});
