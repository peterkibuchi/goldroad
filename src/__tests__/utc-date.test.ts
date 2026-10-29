// @vitest-environment node
import { describe, expect, it } from "vitest";

import { utcLongDate, utcMonthYear, utcShortDate } from "../lib/utc-date";

// Every month, the first and last days, a leap day, and the hours either side
// of UTC midnight, in years from the Unix epoch to four digits.
const dates = [1970, 1999, 2000, 2024, 2026, 2100, 9999].flatMap((year) =>
  Array.from({ length: 12 }, (_, month) => [
    new Date(Date.UTC(year, month, 1, 0, 0, 0)),
    new Date(Date.UTC(year, month + 1, 0, 23, 59, 59)),
    new Date(Date.UTC(year, month, 15, 12, 30)),
  ]).flat(),
);
dates.push(new Date("2024-02-29T23:00:00-05:00"));

describe("the reader's UTC dates match toLocaleDateString exactly", () => {
  it("utcLongDate is en-US long", () => {
    for (const d of dates)
      expect(utcLongDate(d)).toBe(
        d.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        }),
      );
  });

  it("utcMonthYear is en-US month and year", () => {
    for (const d of dates)
      expect(utcMonthYear(d)).toBe(
        d.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
      );
  });

  it("utcShortDate is en-GB short", () => {
    for (const d of dates)
      expect(utcShortDate(d)).toBe(
        d.toLocaleDateString("en-GB", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
      );
  });
});
