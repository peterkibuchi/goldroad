/**
 * Workers Cron body (free tier: up to 5 triggers/account). SIX jobs, run
 * hourly from ONE trigger:
 *
 * 1. Publish scheduled posts that are due (~/lib/scheduled-posts), purging the
 *    reading surfaces each one changes (~/lib/scheduled-publish). It runs
 *    FIRST, and that ordering is deliberate: it is the only job here a reader
 *    will ever notice, since a tick that runs out of budget before reaching it
 *    is a writer's post going out late. Everything below it is either
 *    self-healing on the next hour (the follower sample is capped and
 *    idempotent per day) or reported by CI. The pass is bounded — a handful of
 *    posts per tick — and says in its log line when it left a queue behind.
 *
 *    The tick's 50 subrequests are shared: three publishes spend up to 42, the
 *    follower sample 2, the alerts one each, and the self-check none (it runs
 *    in-process), so the jobs behind the publishes keep room.
 * 2. Purge expired oauth_kv rows. `D1Store.get` only deletes an
 *    expired row when that exact key is read again, so abandoned authorize
 *    `state:` rows and idle sessions (`sess:`, see ~/lib/live-session) would
 *    otherwise accumulate forever, refresh tokens included.
 * 3. Sample follower counts, one row per writer per UTC day, and prune samples
 *    past their retention window (~/lib/follower-snapshots). Hourly rather than
 *    daily on purpose: the pass is idempotent per day, so running it 24 times
 *    self-heals a missed midnight run, a platform blip, or a writer who first
 *    signs in at 14:00. Batched, so a full run is two AppView calls.
 * 4. A backup-freshness check (~/lib/backup). The nightly off-platform export
 *    runs in CI, not here — D1's export is an account-scoped REST operation, not
 *    something the `DB` binding can do. What this adds is the part CI cannot
 *    self-report: a backup job that has silently stopped looks exactly like one
 *    that is working, so the cron watches the heartbeat CI stamps and folds any
 *    complaint into the same alert path as the self-check below.
 * 5. Alert on abuse reports nobody has been told about (~/lib/reports). It
 *    belongs here and not inline in /api/report because that endpoint is
 *    unauthenticated: an inline webhook would let anyone turn a spam flood into
 *    an alert flood. Batching bounds the alert volume by this cron instead. It
 *    runs ahead of the self-check because a takedown request going unread is a
 *    legal exposure, while a missed self-check hour is a backstop whose primary
 *    is the external uptime monitor.
 * 6. A self-check of core invariants, through our own handler in-process
 *    (`selfCheck`). Logs are on but nobody is alerted by
 *    default; this POSTs failures to WEBHOOK_URL if that secret is set, and is
 *    a silent no-op otherwise. External uptime monitoring remains the primary
 *    alerting path — this is a cheap always-on backstop.
 */
import { and, isNotNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { oauthKv } from "~/db/schema";
import { ALERT_TIMEOUT_MS, chatSummary, isTimeout } from "~/lib/alert-webhook";
import { d1BackupStore, runBackupCheck } from "~/lib/backup";
import {
  d1SnapshotStore,
  runFollowerSnapshotPass,
  type SnapshotPassResult,
} from "~/lib/follower-snapshots";
import { backfillSessionExpiry } from "~/lib/live-session";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { generateTid } from "~/lib/publish";
import { d1ReportStore, runReportAlertPass } from "~/lib/reports";
import {
  d1ScheduledPostStore,
  runScheduledPublishPass,
} from "~/lib/scheduled-posts";
import { cronPublisher } from "~/lib/scheduled-publish";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** WHERE for expired oauth_kv rows: an expiry is set AND it's in the past. */
export function expiredOauthKvCondition(now: number) {
  return and(isNotNull(oauthKv.expiresAt), lte(oauthKv.expiresAt, now));
}

/** Delete expired authorize states and idle sessions. */
export function purgeExpiredOauthKv(db: DrizzleD1, now: number) {
  return db.delete(oauthKv).where(expiredOauthKvCondition(now));
}

/** Our own fetch handler, called in-process (see src/server.ts). */
export type FetchOwn = (request: Request) => Promise<Response>;

/**
 * Core-invariant self-check, run through our own handler in-process. Returns
 * human-readable failure strings (empty = healthy).
 *
 * It asks the OAuth client-metadata route for its client_id, which fails when
 * the OAuth key or secrets are missing or broken (the route answers 500) or
 * the metadata stops naming the canonical origin. Being in-process, it can't
 * see DNS, routing or WAF trouble; the external uptime monitor watches that,
 * and the homepage. It doesn't render a page: that would spend the tick's CPU
 * budget just before the alert that reports on it.
 */
export async function selfCheck(fetchOwn: FetchOwn): Promise<string[]> {
  const failures: string[] = [];
  try {
    const res = await fetchOwn(
      new Request(`${CANONICAL_ORIGIN}/oauth/client-metadata.json`),
    );
    const json = (await res.json().catch(() => null)) as {
      client_id?: string;
    } | null;
    const expected = `${CANONICAL_ORIGIN}/oauth/client-metadata.json`;
    if (json?.client_id !== expected)
      failures.push(
        `OAuth client_id is "${json?.client_id}", expected ${expected}`,
      );
  } catch (err) {
    failures.push(`client-metadata threw: ${String(err)}`);
  }
  return failures;
}

export type AlertDelivery = {
  /** Whether a POST was attempted — a webhook is set AND something is wrong. */
  attempted: boolean;
  /** Why the alert did not land, in the words an operator reads. Empty unless a
   * POST was attempted and rejected. */
  failures: string[];
};

/** The one-line headline a chat channel renders: how many invariants broke and
 * the first of them. The rest travel in `failures` for a JSON sink;
 * `chatSummary` clips this hard, which matters because a failure string can
 * carry a `String(err)` or a value read off a remote response. */
function summarize(failures: string[]): string {
  const count = `${failures.length} failure${failures.length === 1 ? "" : "s"}`;
  return `Goldroad self-check: ${count} — ${failures[0]}`;
}

/**
 * POST failures to the alert webhook, but only when both a webhook and at least
 * one failure exist.
 *
 * A non-2xx is a message nobody received, exactly as in ~/lib/reports, and used
 * to be indistinguishable from success here: the old `.catch()` only saw
 * network rejections, while an HTTP 400 resolves. That is the shape a chat
 * webhook rejecting a body actually takes, so the failure it hid was the one
 * most likely to happen.
 *
 * The POST is bounded on the same deadline as the abuse alert. This is the last
 * job in an hourly cron, so a webhook that accepts the connection and then says
 * nothing would hold the whole tick open waiting on a third party we don't run
 * — the one failure mode that costs more than the alert it is failing to send.
 */
export async function reportFailures(
  webhook: string | undefined,
  failures: string[],
): Promise<AlertDelivery> {
  if (!webhook || failures.length === 0)
    return { attempted: false, failures: [] };
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // `content`/`text` first, and not optional: Discord answers 400 to a
        // body carrying none of its renderable fields and Slack shows an empty
        // message, so without this the fields below reach nobody at all
        // (~/lib/alert-webhook).
        ...chatSummary(summarize(failures)),
        source: "goldroad-cron",
        // Two different things now post to this one webhook. Without a
        // discriminator on BOTH, anything routing on `kind` gets `undefined` for
        // these and has to sniff for a `failures` key to tell them apart.
        kind: "self-check",
        failures,
        at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("alert webhook POST ->", res.status);
      return {
        attempted: true,
        failures: [`self-check alert rejected by the webhook (${res.status})`],
      };
    }
  } catch (err) {
    console.error("alert webhook POST failed", err);
    // A deadline we imposed and a network that refused are different problems —
    // one is a webhook that hangs, the other a URL that is wrong or gone — and
    // the operator reading the line is the one who has to tell them apart.
    return {
      attempted: true,
      failures: [
        isTimeout(err)
          ? `self-check alert timed out after ${ALERT_TIMEOUT_MS} ms`
          : "self-check alert could not be delivered",
      ],
    };
  }
  return { attempted: true, failures: [] };
}

/** WEBHOOK_URL is an OPTIONAL Workers secret (operator-provided), so it isn't in
 * the generated Env bindings — model it as an optional field. An Env value
 * satisfies this intersection because the property is optional. */
type CronEnv = Env & { WEBHOOK_URL?: string };

/**
 * Follower sampling is the one job in this pass whose failure is IRREVERSIBLE.
 * Upstream reports a follower count for today only, so a day nobody sampled is
 * a permanent hole in every writer's growth chart — and the chart renders that
 * hole honestly, which means the first person to notice is a writer looking at
 * their own missing history weeks later.
 *
 * Everything else on the alert path is either self-healing or already reported
 * by CI. This was the only irreversible job with no alarm on it, which is
 * exactly backwards, so it now rides the same channel.
 *
 * A pass that attempted nobody is not a failure — it means every writer already
 * had today's reading, which is the steady state on an hourly cron.
 */
function snapshotFailures(result: SnapshotPassResult): string[] {
  const failures: string[] = [];
  if (result.attempted > 0 && result.sampled === 0)
    failures.push(
      `follower sampling took 0 of ${result.attempted} readings for ${result.day}`,
    );
  if (!result.pruned) failures.push("follower snapshot prune failed");
  return failures;
}

/** The cron handler body: publish what's due, purge, sample follower counts,
 * check the backup heartbeat, alert on new abuse reports, self-check, alert.
 * Never throws (a cron that throws just retries; we'd rather log and move on),
 * and each job is independent — a failure in one still leaves the others run. */
export async function runScheduled(
  env: CronEnv,
  fetchOwn: FetchOwn,
): Promise<void> {
  const db = drizzle(env.DB);
  // Scheduled posts first — the one job whose lateness a reader can see. The
  // pass never throws and reports what it did, including whether it hit its
  // per-tick cap; failures are recorded ON THE ROW in words the writer reads in
  // the posts manager, which is why they don't ride the operator alert path
  // below. A revoked grant is the writer's to fix, not something the operator
  // should be alerted about; systemic trouble shows up as a run of them in
  // this log line.
  const scheduled = await runScheduledPublishPass({
    store: d1ScheduledPostStore(db),
    publish: cronPublisher(db),
    mintRkey: generateTid,
  });
  console.log("scheduled publish pass", scheduled);
  try {
    await backfillSessionExpiry(db, Date.now());
    await purgeExpiredOauthKv(db, Date.now());
  } catch (err) {
    console.error("oauth_kv purge failed", err);
  }
  // Abuse reports go out on their own POST rather than joining the failure list
  // below: a takedown request is a queue item to work through, not an invariant
  // that broke, and it must not be suppressed by the "only alert if something
  // is wrong" rule the self-check applies. Its FAILURES do join that list.
  // It runs ahead of the follower sampling: an unheard takedown is legal
  // exposure, and a missed sample self-heals next hour.
  //
  // Guarded like the purge above: the pass is written never to throw, and the
  // belt-and-braces catch keeps a surprise inside it from costing the rest.
  let reported = { failures: [] as string[] };
  try {
    reported = await runReportAlertPass({
      store: d1ReportStore(db),
      webhook: env.WEBHOOK_URL,
    });
    console.log("abuse report alert pass", reported);
  } catch (err) {
    console.error("abuse report alert pass failed", err);
    reported = { failures: ["abuse-report alert pass threw"] };
  }
  // Follower counts are point-in-time only upstream, so a day that isn't
  // sampled can never be recovered.
  const snapshots = await runFollowerSnapshotPass({
    store: d1SnapshotStore(db),
  });
  console.log("follower snapshot pass", snapshots);
  // One indexed row read.
  const backup = await runBackupCheck({ store: d1BackupStore(db) });
  console.log("backup check", backup);
  // A stale backup is a real invariant failure, so it rides the self-check's
  // alert path rather than getting a second, parallel one.
  const failures = [
    ...(await selfCheck(fetchOwn)),
    ...backup.failures,
    ...snapshotFailures(snapshots),
    ...reported.failures,
  ];
  if (failures.length > 0) console.error("cron self-check failures", failures);
  // This is the last job in the pass, so there is no later failure list for a
  // rejected alert to join — and nothing persists across ticks to carry one.
  // The log line is therefore the only record that the alert CHANNEL itself is
  // down, which is precisely why it is an error rather than a shrug: an
  // invariant that is still broken next hour re-alerts and fails again, and a
  // run of these lines is what tells an operator the webhook is the problem
  // rather than the site.
  const alert = await reportFailures(env.WEBHOOK_URL, failures);
  if (alert.failures.length > 0)
    console.error("cron alert delivery failures", alert.failures);
}
