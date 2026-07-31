/**
 * The JSON response every writer-private API answers with.
 *
 * `private` matters as much as `no-store`: these payloads are one writer's
 * drafts, imports, stats, and full account export. `no-store` alone already
 * forbids storage, but `private` states the intent to any shared cache in the
 * path (a corporate proxy, a CDN someone puts in front of a self-hosted
 * deployment) that a permissive reading of `no-store` might not catch.
 *
 * One definition on purpose: this header used to be copy-pasted into six
 * handlers, and the sixth had already drifted — the five carrying drafts,
 * imports, and the account export were the ones missing `private`.
 */
export function privateJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
