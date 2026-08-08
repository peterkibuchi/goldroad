/**
 * Abuse-report alerting: the part of the moderation kit that tells a human a
 * report arrived. Without it a takedown request sits in D1 unread, and the
 * first sign of trouble is a lawyer's letter.
 *
 * WHY THE CRON AND NOT /api/report. The intake endpoint is UNAUTHENTICATED. A
 * webhook POST fired inline from it would hand anyone a lever: one spam flood
 * becomes one alert flood, and the channel that is supposed to surface a
 * takedown becomes the channel nobody reads. It would also hang an outbound
 * network call off an anonymous request path. Batching from the hourly cron
 * bounds alert volume by the cron instead of by the attacker. Up to an hour of
 * latency on a takedown queue is a price worth paying for that; unbounded alert
 * amplification is not.
 *
 * WHY A WATERMARK COLUMN AND NOT A TIME WINDOW. `created_at > now - 1h` looks
 * equivalent and is not: a tick that fires early re-sends reports it already
 * sent, and a tick that is missed drops an hour of reports on the floor
 * permanently — both silently. `notified_at` records what was actually
 * delivered, so a missed hour is a delayed alert rather than a lost one.
 *
 * WHICH MEANS THE STAMP FOLLOWS THE POST, NEVER PRECEDES IT. ~/lib/scheduled's
 * `reportFailures` fires and forgets, which is right for a self-check that
 * re-runs next hour and re-reports the same failure. It is wrong here: a
 * dropped POST plus a stamped row loses the report for good. So this pass
 * checks `res.ok` and only then writes the watermark; anything less leaves the
 * rows alone for the next tick to retry.
 *
 * SHAPE. A drizzle query builder (verifiable via `.toSQL()` without a live D1),
 * pure functions, and a pass over an injectable store — the same shape as
 * ~/lib/backup and ~/lib/follower-snapshots.
 */
import { asc, inArray, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { reports } from "~/db/schema";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** Reports carried by a single alert. The cap is the whole defence against a
 * flood building an unbounded payload: the rest stay unnotified and go out on
 * the following ticks, which is the same retry path a failed POST uses. */
export const MAX_REPORTS_PER_ALERT = 50;

/** How much of a reporter's note travels in the alert. The note is validated up
 * to 2,000 characters, and fifty of those would be a ~100 KB body that most
 * chat webhooks reject outright — losing the whole alert to say more about one
 * report. The alert is a pointer to the queue, not a copy of it. */
export const MAX_ALERT_REASON_CHARS = 280;

/** Where a human goes to read the full report, including the reporter's email.
 * There is no admin UI yet (same as `hidden_content`), so this names the table
 * rather than a URL. */
const TRIAGE_HINT =
  "triage the `reports` table in D1; reporter contact details stay there";

/** The columns the alert path is allowed to see. No `email` — see
 * `selectUnnotifiedReports`. */
export type PendingReport = { id: number; url: string; reason: string };

/**
 * Reports nobody has been told about yet, oldest first.
 *
 * THE PROJECTION IS THE PII BOUNDARY. `reports.email` is deliberately not
 * selected, so the alert path never holds the address it must not send — a
 * later change to the payload builder cannot leak a column this query never
 * read. Oldest first because the point is a queue, and capped so one flood
 * cannot build an unbounded body.
 */
export function selectUnnotifiedReports(
  db: DrizzleD1,
  limit: number = MAX_REPORTS_PER_ALERT,
) {
  return db
    .select({ id: reports.id, url: reports.url, reason: reports.reason })
    .from(reports)
    .where(isNull(reports.notifiedAt))
    .orderBy(asc(reports.createdAt))
    .limit(limit);
}

/** Stamp the watermark on exactly the ids that went out in a delivered alert —
 * never on a whole time range, which would also stamp rows that arrived while
 * the POST was in flight. */
export function markReportsNotified(db: DrizzleD1, ids: number[], at: Date) {
  return db
    .update(reports)
    .set({ notifiedAt: at })
    .where(inArray(reports.id, ids));
}

/** The narrow slice of storage the pass needs. One real implementation
 * (`d1ReportStore`); tests hand it a plain object. */
export type ReportStore = {
  unnotified(limit: number): Promise<PendingReport[]>;
  markNotified(ids: number[], at: Date): Promise<unknown>;
};

export function d1ReportStore(db: DrizzleD1): ReportStore {
  return {
    unnotified(limit) {
      return selectUnnotifiedReports(db, limit);
    },
    markNotified(ids, at) {
      return markReportsNotified(db, ids, at);
    },
  };
}

export type ReportAlert = {
  source: "goldroad-cron";
  kind: "abuse-reports";
  count: number;
  reports: PendingReport[];
  triage: string;
  at: string;
};

/** `text` shortened to `max` characters, marked as shortened. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The alert body — pure, so what does and does not travel is testable without a
 * network.
 *
 * Field by field rather than a spread: the destination is a chat channel, which
 * is a far wider audience than the moderation queue, so the payload lists what
 * a triager needs to act (how many, which URLs, what was alleged, which rows)
 * and points at the database for anything more. A reporter who left an email
 * gave it for follow-up, not for broadcast.
 */
export function buildReportAlert(
  pending: readonly PendingReport[],
  now: number = Date.now(),
): ReportAlert {
  return {
    source: "goldroad-cron",
    kind: "abuse-reports",
    count: pending.length,
    reports: pending.map((row) => ({
      id: row.id,
      url: row.url,
      reason: clip(row.reason, MAX_ALERT_REASON_CHARS),
    })),
    triage: TRIAGE_HINT,
    at: new Date(now).toISOString(),
  };
}

/** A chat webhook that hasn't answered in this long is not going to. Bounds the
 * one job in the cron pass that talks to a third party we don't run. */
const ALERT_TIMEOUT_MS = 5_000;

export type ReportAlertResult = {
  /** Unnotified reports read this tick (post-cap). */
  found: number;
  /** Whether the webhook accepted the alert. */
  sent: boolean;
  /** Rows whose watermark was stamped — 0 unless `sent`. */
  notified: number;
  /** The read filled its batch, so there may be more waiting for the next
   * tick. */
  capped: boolean;
};

/**
 * The cron's abuse-report pass: read what nobody has been told about, alert,
 * and only then stamp.
 *
 * Never throws. A cron that throws is simply retried, and this job sits ahead
 * of the self-check in the same tick — a failure here must cost this alert, not
 * the pass around it.
 *
 * Two deliberate asymmetries:
 *  • No webhook configured is a no-op that leaves every row unnotified. The
 *    reports are still in D1, and the day a webhook is set they all go out.
 *    Stamping them would quietly discard the backlog.
 *  • A POST that succeeded followed by a stamp that failed re-alerts the same
 *    reports next hour. A duplicate ping about a report already triaged is
 *    cheap; the opposite mistake is a takedown nobody hears about.
 */
export async function runReportAlertPass(opts: {
  store: ReportStore;
  webhook?: string;
  now?: number;
  fetcher?: typeof fetch;
  cap?: number;
}): Promise<ReportAlertResult> {
  const {
    store,
    webhook,
    now = Date.now(),
    fetcher = fetch,
    cap = MAX_REPORTS_PER_ALERT,
  } = opts;
  const result: ReportAlertResult = {
    found: 0,
    sent: false,
    notified: 0,
    capped: false,
  };

  let pending: PendingReport[];
  try {
    pending = await store.unnotified(cap);
  } catch (err) {
    // Likeliest cause is the migration not having been applied. Reported, not
    // swallowed — "no reports" and "cannot read reports" must not look alike.
    console.error("unnotified report read failed", err);
    return result;
  }

  result.found = pending.length;
  result.capped = pending.length >= cap;
  if (pending.length === 0) return result;
  if (result.capped)
    console.warn(`abuse-report alert filled its batch of ${cap} this tick`);

  if (!webhook) {
    console.warn(
      `${pending.length} unnotified abuse report(s), no WEBHOOK_URL set`,
    );
    return result;
  }

  try {
    const res = await fetcher(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildReportAlert(pending, now)),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    // `res.ok`, not merely "didn't throw": a 4xx/5xx from the webhook is a
    // message nobody received, and stamping on it would lose the report.
    if (!res.ok) {
      console.error("abuse-report alert POST ->", res.status);
      return result;
    }
  } catch (err) {
    console.error("abuse-report alert POST failed", err);
    return result;
  }
  result.sent = true;

  try {
    const ids = pending.map((row) => row.id);
    await store.markNotified(ids, new Date(now));
    result.notified = pending.length;
  } catch (err) {
    console.error("report watermark update failed", err);
  }

  return result;
}
