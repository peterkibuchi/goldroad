/**
 * The browser's side of the search backfill: call /api/search/backfill until
 * it says the writer's posts are all indexed. Run from the dashboard, in the
 * background; the server keeps the cursor, so a tab closed halfway resumes on
 * the next visit, and once it is done each visit costs one call.
 */

/** Calls one dashboard visit makes at most: 5,000 posts at 20 a page. */
export const MAX_BACKFILL_CALLS = 250;

/** True once the server reports the backfill complete; false when it stopped
 * early (a refusal, a network error, or the call cap), to resume next time. */
export async function runSearchBackfill(
  fetchImpl: typeof fetch = fetch,
  maxCalls: number = MAX_BACKFILL_CALLS,
): Promise<boolean> {
  for (let call = 0; call < maxCalls; call++) {
    const res = await fetchImpl("/api/search/backfill", {
      method: "POST",
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as {
      ok?: unknown;
      done?: unknown;
    } | null;
    if (!res?.ok || data?.ok !== true) return false;
    if (data.done === true) return true;
  }
  return false;
}
