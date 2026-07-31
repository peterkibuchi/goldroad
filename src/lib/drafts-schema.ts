/**
 * Validation for the /api/drafts payload and the drafts caps. Pure module —
 * no `cloudflare:workers` import, so tests can import it.
 */
import { z } from "zod";

import {
  MAX_BODY_LENGTH,
  MAX_DEK_LENGTH,
  MAX_TITLE_LENGTH,
} from "~/lib/publish";

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
 *
 * `dek` (the subtitle) defaults to "" so a save from an older client — or from
 * any caller that simply has no subtitle to send — is a valid save rather than
 * a rejected one.
 *
 * `markdown` is the publish-time projection of the same document (see
 * `drafts.markdown` in ~/db/schema), and it is OPTIONAL WITH NO DEFAULT on
 * purpose: absent means "leave the stored projection alone", not "the
 * projection is empty". A tab left open across a deploy keeps saving its blocks
 * happily, and a scheduled post keeps the words it was scheduled with — where
 * a default of "" would silently blank the only copy a cron can publish.
 */
export const draftPayload = z.object({
  id: z.string().regex(DRAFT_ID_RE).optional(),
  title: z.string().max(MAX_TITLE_LENGTH),
  dek: z.string().max(MAX_DEK_LENGTH).default(""),
  content: z.array(z.unknown()),
  markdown: z.string().max(MAX_BODY_LENGTH).optional(),
});

export type DraftPayload = z.infer<typeof draftPayload>;
