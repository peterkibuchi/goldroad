/**
 * Scheduling times: the writer's wall clock in, UTC out.
 *
 * ONE DIRECTION OF TRUTH. A writer picks "Tuesday, 9:00 AM" and means it in
 * their own zone; storage keeps a single UTC instant (`scheduled_posts.due_at`,
 * unix ms). The zone itself is never stored — a stored offset is a stored guess
 * about what a government will do to a DST rule between now and Tuesday, and
 * the instant the writer chose does not change when that guess turns out wrong.
 *
 * The conversion needs an offset the server cannot know, so the browser sends
 * the one in effect AT THE CHOSEN MOMENT (`new Date(y, m, d, hh, mm)
 * .getTimezoneOffset()` — constructing the local date is what makes it the
 * target date's offset rather than today's). Everything here is pure: no
 * `Date.now()` default, no Intl in the parsing path, so a test can pin any
 * zone by passing a number.
 *
 * Sign convention, since it is the easy thing to get backwards:
 * `getTimezoneOffset()` returns UTC minus local, in minutes — so it is
 * NEGATIVE east of Greenwich (Nairobi, UTC+3, reports -180), and
 * `utc = local + offset` in every case.
 */

/** What `<input type="datetime-local">` submits: no zone, minute precision.
 * Some browsers append seconds, so they are accepted and ignored. */
const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/** Real zones run from UTC−12 to UTC+14, so offsets live in ±840 minutes.
 * Anything outside that is a hostile or broken submission, not a zone. */
const MAX_OFFSET_MINUTES = 840;

const MS_PER_MINUTE = 60_000;

/** How far ahead a schedule must be to be worth accepting. The cron fires
 * hourly, so this is not "how soon it can publish" (that is the next tick) —
 * it is the line between a time the writer meant and a time that had already
 * passed while they were typing. */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

/** A year out. Not a product rule — a bound, so a stray keystroke can't park a
 * row in the table until 4891. */
export const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** The offset a browser reported, or null when it isn't one. Whole minutes:
 * every real zone offset is (Newfoundland included), and a fractional one
 * would only ever come from a caller inventing numbers. */
export function isZoneOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value) <= MAX_OFFSET_MINUTES
  );
}

/**
 * A local wall-clock string plus the offset in effect at that moment → the UTC
 * instant, in unix ms. null for anything that isn't both.
 *
 * The parse is deliberately by hand rather than `new Date(local)`: an
 * offset-less datetime string is parsed as LOCAL time by the runtime, which on
 * a Worker means UTC and on a laptop means whatever the laptop thinks — the one
 * ambiguity this function exists to remove. Building the instant with
 * `Date.UTC` and then applying the offset has no such reading.
 */
export function localToUtcMs(
  local: unknown,
  offsetMinutes: unknown,
): number | null {
  if (typeof local !== "string" || !isZoneOffset(offsetMinutes)) return null;
  const match = LOCAL_INPUT_RE.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Rejects the impossible dates Date.UTC would happily roll over (Feb 31
  // becoming Mar 3): a writer who typed one gets told, not silently moved.
  const rolled = new Date(asIfUtc);
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day)
    return null;
  return asIfUtc + offsetMinutes * MS_PER_MINUTE;
}

/**
 * The inverse, for prefilling the picker with a schedule that already exists:
 * a UTC instant read back as the writer's own wall clock, in the format
 * `<input type="datetime-local">` accepts.
 */
export function utcMsToLocalInput(
  ms: number,
  offsetMinutes: number,
): string | null {
  if (!Number.isFinite(ms) || !isZoneOffset(offsetMinutes)) return null;
  return new Date(ms - offsetMinutes * MS_PER_MINUTE)
    .toISOString()
    .slice(0, 16);
}

/**
 * The zone offset in effect at a local wall-clock moment, as the browser knows
 * it — the one function here that depends on where it runs, which is exactly
 * why it is the only thing the client contributes to the conversion.
 *
 * It constructs the LOCAL date from the parts rather than reading
 * `new Date().getTimezoneOffset()`, so a time chosen on the far side of a DST
 * change carries that side's offset. Reading today's offset instead is the
 * classic way a 9:00 AM schedule goes out at 10:00.
 *
 * Returns null for anything that isn't a wall-clock string, so the caller sends
 * no offset at all and the server refuses the submission — never a silent
 * fallback to UTC.
 */
export function zoneOffsetForLocalInput(local: string): number | null {
  const match = LOCAL_INPUT_RE.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const offset = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
  ).getTimezoneOffset();
  return isZoneOffset(offset) ? offset : null;
}

export type DueAtProblem = "invalid" | "past" | "too_far";

/**
 * Is this a moment we will accept a schedule for? Returns the problem rather
 * than a boolean so the handler can say which one it was — "that time has
 * already passed" and "that's more than a year out" are different sentences to
 * a writer, and neither is "invalid".
 */
export function dueAtProblem(
  dueMs: number | null,
  now: number,
): DueAtProblem | null {
  if (dueMs === null || !Number.isFinite(dueMs)) return "invalid";
  if (dueMs < now + MIN_SCHEDULE_LEAD_MS) return "past";
  if (dueMs > now + MAX_SCHEDULE_HORIZON_MS) return "too_far";
  return null;
}

/**
 * The writer's own zone, spelled out — "Tue, Aug 4, 2026 at 9:00 AM EAT".
 *
 * Client-side only, and that is the whole point: `timeZone` left undefined
 * means the browser's, which is the only place the writer's zone is actually
 * known. The `timeZoneName` is not decoration — a scheduled time with no zone
 * on it is exactly the label a writer misreads while travelling.
 */
export function formatLocalScheduledAt(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  });
}

/** The same instant labelled in UTC — what the server renders, because the
 * server does not know the writer's zone and a fixed locale + UTC is how every
 * other date in this codebase stays identical across SSR and hydration. Never
 * a wrong time; just a less useful one until the browser takes over. */
export function formatUtcScheduledAt(iso: string): string {
  return formatLocalScheduledAt(iso, "UTC");
}
