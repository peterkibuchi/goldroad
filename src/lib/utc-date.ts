/**
 * The reader's dates, in a fixed locale and UTC so the server and the client
 * render the same string and hydration doesn't drift.
 *
 * Built from the UTC fields rather than `toLocaleDateString`: the first
 * `Intl` date format in a page sets up ICU's locale and time zone data, which
 * measured 200 to 370 ms of main thread with the CPU slowed 4x (Lighthouse's
 * mobile setting), inside hydration on every reader page. Each function's
 * output is byte-identical to the `toLocaleDateString` call it names, which
 * its test pins.
 */

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "January 5, 2026": `toLocaleDateString("en-US", { year: "numeric",
 * month: "long", day: "numeric", timeZone: "UTC" })`. */
export function utcLongDate(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** "January 2026": `toLocaleDateString("en-US", { month: "long",
 * year: "numeric", timeZone: "UTC" })`. */
export function utcMonthYear(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "5 Jan 2026": `toLocaleDateString("en-GB", { year: "numeric",
 * month: "short", day: "numeric", timeZone: "UTC" })`. */
export function utcShortDate(date: Date): string {
  const month = date.getUTCMonth();
  // British English abbreviates September to four letters.
  const short = MONTHS[month].slice(0, month === 8 ? 4 : 3);
  return `${date.getUTCDate()} ${short} ${date.getUTCFullYear()}`;
}
