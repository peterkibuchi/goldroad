/**
 * Validation for the /api/drafts payload and the drafts caps. Pure module —
 * no `cloudflare:workers` import, so tests can import it.
 */
import { z } from "zod";

import { MAX_TITLE_LENGTH } from "~/lib/publish";

/**
 * Hard cap on the /api/drafts request body, enforced BEFORE any JSON parsing
 * (see readBodyCapped in ~/lib/blob): an unauthenticated-sized bound on what
 * a save can cost the worker. Comfortably above the publish-time body cap
 * (100k chars) since block JSON carries structure alongside the text.
 */
export const MAX_DRAFT_BODY_BYTES = 256 * 1024;

/** Per-writer draft cap; creates beyond it are rejected with `draft_limit`.
 * A guardrail against unbounded rows, not a product quota. */
export const MAX_DRAFTS_PER_USER = 50;

/** Draft ids are server-minted crypto.randomUUID() values. Validated
 * everywhere an id crosses a trust boundary (query param, JSON body, form
 * field) so junk never reaches a query. */
const DRAFT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDraftId(value: string): boolean {
  return DRAFT_ID_RE.test(value);
}

/**
 * The create/update (upsert) payload. `content` is the BlockNote document —
 * an array of blocks the server treats as opaque JSON (the editor is the only
 * reader); it is re-serialized server-side for storage. `id` present = update
 * my existing draft; absent = create a new one.
 */
export const draftPayload = z.object({
  id: z.string().regex(DRAFT_ID_RE).optional(),
  title: z.string().max(MAX_TITLE_LENGTH),
  content: z.array(z.unknown()),
});

export type DraftPayload = z.infer<typeof draftPayload>;
