/**
 * Workers Cron body (free tier: up to 5 triggers/account). Two jobs, run
 * hourly from one trigger:
 *
 * 1. Purge expired oauth_kv rows (audit #7). `D1Store.get` only deletes an
 *    expired row when that exact key is read again, so abandoned authorize
 *    `state:` rows — every login started but never completed — accumulate
 *    forever. This sweeps them. Sessions (`sess:`, expires_at = null) are left
 *    alone; they're removed on logout.
 * 2. A self-check of core invariants (audit #6). Logs are on but nobody is
 *    paged; this POSTs failures to WEBHOOK_URL if that secret is set, and is a
 *    silent no-op otherwise. The GitHub-Action canary remains the primary
 *    alerting path — this is a cheap always-on backstop.
 */
import { and, isNotNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { oauthKv } from "~/db/schema";
import { CANONICAL_ORIGIN } from "~/lib/origin";

type DrizzleD1 = ReturnType<typeof drizzle>;

/** WHERE for expired oauth_kv rows: an expiry is set AND it's in the past.
 * Rows with expires_at = null (sessions) never match. */
export function expiredOauthKvCondition(now: number) {
  return and(isNotNull(oauthKv.expiresAt), lte(oauthKv.expiresAt, now));
}

/** Delete expired authorize-state rows (audit #7). Exposed (and unit-tested via
 * .toSQL()) so the query is verifiable without a live D1. */
export function purgeExpiredOauthKv(db: DrizzleD1, now: number) {
  return db.delete(oauthKv).where(expiredOauthKvCondition(now));
}

/** Core-invariant self-check against the live origin (audit #6). Returns a list
 * of human-readable failure strings (empty = healthy). `origin` is injectable
 * for tests. */
export async function selfCheck(
  origin: string = CANONICAL_ORIGIN,
): Promise<string[]> {
  const failures: string[] = [];
  try {
    const res = await fetch(`${origin}/`);
    if (!res.ok) failures.push(`GET / -> ${res.status}`);
    else if (!(await res.text()).includes("Goldroad"))
      failures.push("GET / is missing the wordmark");
  } catch (err) {
    failures.push(`GET / threw: ${String(err)}`);
  }
  try {
    const res = await fetch(`${origin}/oauth/client-metadata.json`);
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

/** POST failures to the alert webhook, but only when both a webhook and at
 * least one failure exist. Returns whether a POST was attempted. */
export async function reportFailures(
  webhook: string | undefined,
  failures: string[],
): Promise<boolean> {
  if (!webhook || failures.length === 0) return false;
  await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "goldroad-cron",
      failures,
      at: new Date().toISOString(),
    }),
  }).catch((err) => console.error("alert webhook POST failed", err));
  return true;
}

/** WEBHOOK_URL is an OPTIONAL Workers secret (owner-provided), so it isn't in
 * the generated Env bindings — model it as an optional field. An Env value
 * satisfies this intersection because the property is optional. */
type CronEnv = Env & { WEBHOOK_URL?: string };

/** The cron handler body: purge, self-check, alert. Never throws (a cron that
 * throws just retries; we'd rather log and move on). */
export async function runScheduled(env: CronEnv): Promise<void> {
  try {
    await purgeExpiredOauthKv(drizzle(env.DB), Date.now());
  } catch (err) {
    console.error("oauth_kv purge failed", err);
  }
  const failures = await selfCheck();
  if (failures.length > 0) console.error("cron self-check failures", failures);
  await reportFailures(env.WEBHOOK_URL, failures);
}
