/**
 * Validation for the /api/drafts payload. Split from ~/lib/drafts-schema so
 * zod stays server-side: a module-level `z.object(...)` is a call the bundler
 * can't prove pure, so any client import of the module ships all of zod.
 */
import { z } from "zod";

import { DRAFT_ID_RE } from "~/lib/drafts-schema";
import {
  MAX_BODY_LENGTH,
  MAX_DEK_LENGTH,
  MAX_INLINE_IMAGES,
  MAX_TITLE_LENGTH,
} from "~/lib/publish";

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
  /** The `images` field's JSON, stored so a publish that happens without the
   * browser (the cron) can still reference the body's blobs. Same
   * absent-means-keep rule as `markdown`, which is what lets a resumed session
   * that uploaded nothing leave the stored references intact. Bounded exactly
   * as the publish form's copy is (~/lib/publish's parseInlineImagesField). */
  inlineImages: z
    .string()
    .max(MAX_INLINE_IMAGES * 500)
    .optional(),
});
