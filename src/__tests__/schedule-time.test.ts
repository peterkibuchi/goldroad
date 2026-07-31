// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  dueAtProblem,
  formatUtcScheduledAt,
  isZoneOffset,
  localToUtcMs,
  MAX_SCHEDULE_HORIZON_MS,
  MIN_SCHEDULE_LEAD_MS,
  utcMsToLocalInput,
  zoneOffsetForLocalInput,
} from "../lib/schedule-time";

/**
 * A writer picks a wall-clock time; storage keeps a UTC instant. This suite
 * pins the direction of that conversion, because getting the sign backwards
 * produces times that look plausible and are wrong by twice the offset — the
 * kind of bug a writer discovers when their Tuesday post goes out on Monday
 * evening.
 */

/** Nairobi, UTC+3 — getTimezoneOffset() reports -180 there. */
const EAT = -180;
/** New York on standard time, UTC-5 → +300. */
const EST = 300;
/** New York on daylight time, UTC-4 → +240. */
const EDT = 240;

describe("localToUtcMs — the writer's clock in, one UTC instant out", () => {
  it("reads 9:00 in UTC+3 as 06:00 UTC", () => {
    expect(localToUtcMs("2026-08-04T09:00", EAT)).toBe(
      Date.parse("2026-08-04T06:00:00.000Z"),
    );
  });

  it("reads 9:00 in UTC-5 as 14:00 UTC — the other sign", () => {
    expect(localToUtcMs("2026-01-13T09:00", EST)).toBe(
      Date.parse("2026-01-13T14:00:00.000Z"),
    );
  });

  it("passes UTC through unchanged", () => {
    expect(localToUtcMs("2026-08-04T09:00", 0)).toBe(
      Date.parse("2026-08-04T09:00:00.000Z"),
    );
  });

  it("honours the offset it was GIVEN, so a DST-straddling schedule is right", () => {
    // Same wall-clock hour on both sides of the US spring-forward. The browser
    // reports the offset in effect on the CHOSEN date, so the two resolve to
    // different UTC instants — which is exactly correct, and impossible if the
    // conversion used "the offset today".
    const winter = localToUtcMs("2026-01-13T09:00", EST);
    const summer = localToUtcMs("2026-07-13T09:00", EDT);
    expect(winter).toBe(Date.parse("2026-01-13T14:00:00.000Z"));
    expect(summer).toBe(Date.parse("2026-07-13T13:00:00.000Z"));
  });

  it("accepts a seconds component some browsers append", () => {
    expect(localToUtcMs("2026-08-04T09:00:00", EAT)).toBe(
      Date.parse("2026-08-04T06:00:00.000Z"),
    );
  });

  it("survives the extremes of the real offset range", () => {
    expect(localToUtcMs("2026-08-04T09:00", -840)).toBe(
      Date.parse("2026-08-03T19:00:00.000Z"),
    );
    expect(localToUtcMs("2026-08-04T09:00", 720)).toBe(
      Date.parse("2026-08-04T21:00:00.000Z"),
    );
  });

  it("refuses junk instead of guessing at it", () => {
    expect(localToUtcMs("", EAT)).toBeNull();
    expect(localToUtcMs("tuesday morning", EAT)).toBeNull();
    expect(localToUtcMs("2026-08-04", EAT)).toBeNull();
    // An offset-carrying string is not a local wall clock — refused rather
    // than half-read.
    expect(localToUtcMs("2026-08-04T09:00:00Z", EAT)).toBeNull();
    expect(localToUtcMs("2026-08-04T25:00", EAT)).toBeNull();
    expect(localToUtcMs("2026-13-04T09:00", EAT)).toBeNull();
    expect(localToUtcMs(null, EAT)).toBeNull();
  });

  it("refuses a date that does not exist rather than rolling it forward", () => {
    // Date.UTC would turn this into March 3rd without a word.
    expect(localToUtcMs("2026-02-31T09:00", EAT)).toBeNull();
  });

  it("refuses an offset no zone has", () => {
    expect(localToUtcMs("2026-08-04T09:00", 900)).toBeNull();
    expect(localToUtcMs("2026-08-04T09:00", -900)).toBeNull();
    expect(localToUtcMs("2026-08-04T09:00", 1.5)).toBeNull();
    expect(localToUtcMs("2026-08-04T09:00", "-180")).toBeNull();
    expect(localToUtcMs("2026-08-04T09:00", Number.NaN)).toBeNull();
  });

  it("isZoneOffset is the same rule, exported for the write door", () => {
    expect(isZoneOffset(-180)).toBe(true);
    expect(isZoneOffset(0)).toBe(true);
    expect(isZoneOffset(841)).toBe(false);
    expect(isZoneOffset(undefined)).toBe(false);
  });
});

describe("utcMsToLocalInput — reading a stored schedule back into the picker", () => {
  it("round-trips through the writer's zone", () => {
    const utc = localToUtcMs("2026-08-04T09:00", EAT) as number;
    expect(utcMsToLocalInput(utc, EAT)).toBe("2026-08-04T09:00");
  });

  it("round-trips west of Greenwich too", () => {
    const utc = localToUtcMs("2026-01-13T23:30", EST) as number;
    expect(utcMsToLocalInput(utc, EST)).toBe("2026-01-13T23:30");
  });

  it("returns null rather than a bogus field value", () => {
    expect(utcMsToLocalInput(Number.NaN, EAT)).toBeNull();
    expect(utcMsToLocalInput(Date.now(), 900)).toBeNull();
  });
});

describe("zoneOffsetForLocalInput — the browser's half of the conversion", () => {
  /**
   * Asserted as a PROPERTY rather than a number, because the answer depends on
   * the zone the test process happens to run in. The property is the whole
   * point: local wall clock + this offset must be the same instant the runtime
   * itself means by that wall clock.
   */
  it("round-trips any local wall clock to the runtime's own instant", () => {
    for (const [local, parts] of [
      ["2026-01-13T09:00", [2026, 0, 13, 9, 0]],
      ["2026-07-13T09:00", [2026, 6, 13, 9, 0]],
      ["2026-11-01T01:30", [2026, 10, 1, 1, 30]],
      ["2027-03-14T02:30", [2027, 2, 14, 2, 30]],
    ] as const) {
      const offset = zoneOffsetForLocalInput(local);
      expect(isZoneOffset(offset)).toBe(true);
      const [y, mo, d, h, mi] = parts;
      expect(localToUtcMs(local, offset)).toBe(
        new Date(y, mo, d, h, mi).getTime(),
      );
    }
  });

  it("returns null for anything that isn't a wall clock, so no offset is sent", () => {
    expect(zoneOffsetForLocalInput("")).toBeNull();
    expect(zoneOffsetForLocalInput("2026-08-04")).toBeNull();
    expect(zoneOffsetForLocalInput("soon")).toBeNull();
  });
});

describe("dueAtProblem — which sentence the writer gets", () => {
  const now = Date.parse("2026-08-04T06:00:00.000Z");

  it("accepts a time comfortably ahead", () => {
    expect(dueAtProblem(now + 3_600_000, now)).toBeNull();
  });

  it("names a time that has already passed", () => {
    expect(dueAtProblem(now - 1000, now)).toBe("past");
    expect(dueAtProblem(now + MIN_SCHEDULE_LEAD_MS - 1, now)).toBe("past");
  });

  it("names a time past the horizon", () => {
    expect(dueAtProblem(now + MAX_SCHEDULE_HORIZON_MS + 1000, now)).toBe(
      "too_far",
    );
  });

  it("calls unparseable input invalid, not past", () => {
    expect(dueAtProblem(null, now)).toBe("invalid");
    expect(dueAtProblem(Number.NaN, now)).toBe("invalid");
  });
});

describe("formatUtcScheduledAt — the label the server can honestly render", () => {
  it("says UTC on it, so a pre-hydration read is never mistaken for local", () => {
    const label = formatUtcScheduledAt("2026-08-04T06:00:00.000Z");
    expect(label).toContain("Aug 4, 2026");
    expect(label).toContain("UTC");
  });

  it("returns an empty string for an unparseable instant", () => {
    expect(formatUtcScheduledAt("not a date")).toBe("");
  });
});
