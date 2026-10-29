/**
 * The drafts caps and the draft id check. Pure module — no `cloudflare:workers`
 * import, so tests can import it — and no zod: the /write route's
 * `validateSearch` imports `isDraftId`, which puts this module in the main
 * client chunk on every page. The /api/drafts payload schema lives in
 * ~/lib/drafts-payload, which only the server imports.
 */

/**
 * Hard cap on the /api/drafts request body, enforced BEFORE any JSON parsing
 * (see readBodyCapped in ~/lib/blob): an unauthenticated-sized bound on what
 * a save can cost the worker. Comfortably above the publish-time body cap
 * (100k chars) since block JSON carries structure alongside the text.
 *
 * Raised from 256 KB when saves began carrying the markdown projection
 * alongside the blocks: the same words now travel twice in one request, and a
 * long draft that used to fit at 250 KB would otherwise start failing its
 * autosave — a silent-looking regression on the one endpoint a writer trusts
 * with unsaved work. Still a bound: the per-writer draft cap is what keeps the
 * product of the two honest.
 */
export const MAX_DRAFT_BODY_BYTES = 512 * 1024;

/** Per-writer draft cap; creates beyond it are rejected with `draft_limit`.
 * A guardrail against unbounded rows, not a product quota. */
export const MAX_DRAFTS_PER_USER = 50;

/** Draft ids are server-minted crypto.randomUUID() values. Validated
 * everywhere an id crosses a trust boundary (query param, JSON body, form
 * field) so junk never reaches a query. */
export const DRAFT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDraftId(value: string): boolean {
  return DRAFT_ID_RE.test(value);
}
