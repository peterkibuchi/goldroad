/**
 * Inline body images, browser side: the upload call the editor's `uploadFile`
 * handler makes, the per-session store that keeps its results, and the block
 * inspections the write page reports to the writer.
 *
 * Pure module — fetch is injectable, no DOM at module scope — so all of it
 * unit-tests without an editor.
 *
 * The store exists because of how atproto blobs work: `uploadBlob` puts the
 * bytes in the writer's repo but the PDS only serves a blob a RECORD
 * references, so between dropping an image and pressing Publish the
 * `/img/<did>/<cid>` path does not resolve yet. So we keep two things per
 * upload: the blob JSON (handed to the publish form, which is what tethers it)
 * and a local object URL (what the editor actually displays until then).
 */

import { downscaleImage } from "~/lib/image";
import { capture } from "~/lib/posthog";

/** Bytes, at the precision a writer cares about ("4.2 MB", "780 KB"). */
export function formatBytes(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/**
 * What the writer is told about a shrink, or null when nothing happened.
 *
 * A 4 MB screenshot dragged into the editor is the ordinary case, not the
 * edge case, and the lexicon caps a blob at 1 MB — so the image is resized
 * rather than refused. Resizing someone's picture behind their back is not
 * acceptable either, hence the notice: it says the image was changed, by how
 * much, and why.
 */
export function downscaleNotice(before: number, after: number): string | null {
  // Only a real reduction is worth a sentence; a re-encode that saved nothing
  // (or the pass-through case, where the same File comes back) stays quiet.
  if (after >= before) return null;
  return `Shrank that image from ${formatBytes(before)} to ${formatBytes(
    after,
  )} so it fits the 1 MB limit.`;
}

/**
 * What the writer is told, per server error code. Every path says what
 * happened and what to do about it — an upload that fails must never look
 * like an upload that is still going.
 */
const UPLOAD_ERROR_MESSAGES: Record<string, string> = {
  no_file: "That file was empty — try another image.",
  image_type:
    "Posts can carry JPEG, PNG, WebP, AVIF, or GIF images. That file isn't one of them.",
  image_too_large:
    "That image is still over 1 MB after shrinking — try a smaller one.",
  image_scope:
    "Adding images needs a permission your sign-in doesn't include yet — re-connect your account and try again.",
  session_expired: "Your session expired — sign in again to add images.",
  upload_failed: "Your server wouldn't store that image. Try again.",
};

const GENERIC_UPLOAD_ERROR =
  "That image couldn't be added right now. Check your connection and try again.";

/** The browser couldn't decode or couldn't compress the file. Says which way
 * out exists rather than leaving an empty block behind. */
const DOWNSCALE_ERROR =
  "That image couldn't be read or shrunk under 1 MB — try saving it as a JPEG or PNG first.";

export function uploadErrorMessage(code: unknown): string {
  return typeof code === "string" && code in UPLOAD_ERROR_MESSAGES
    ? UPLOAD_ERROR_MESSAGES[code]
    : GENERIC_UPLOAD_ERROR;
}

export type UploadedInlineImage = {
  /** Same-origin proxy path — what goes in the markdown. */
  url: string;
  /** The blob JSON, replayed to the publish form so the record can
   * reference it (unreferenced blobs are never served). */
  blob: unknown;
};

/**
 * One image → a blob in the writer's repo, via the single publish handler
 * (`intent=uploadImage`). Throws an Error whose message is writer-facing.
 */
export async function uploadInlineImage(
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadedInlineImage> {
  const form = new FormData();
  form.set("intent", "uploadImage");
  form.set("file", file);
  let res: Response;
  try {
    res = await fetchImpl("/api/publish", { method: "POST", body: form });
  } catch {
    throw new Error(GENERIC_UPLOAD_ERROR);
  }
  // A non-JSON answer (an HTML error page, a proxy interstitial) is a failure
  // like any other — it must not read as success.
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    url?: unknown;
    blob?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok || !data?.ok || typeof data.url !== "string" || !data.url) {
    throw new Error(uploadErrorMessage(data?.error));
  }
  // Inline-image adoption. Size only — no filename, which could carry anything
  // a writer named their file, and no content.
  capture("inline_image_uploaded", { bytes: file.size });
  return { url: data.url, blob: data.blob };
}

export type InlineImageStore = ReturnType<typeof createInlineImageStore>;

/**
 * Per-editor-session record of what has been uploaded. Not React state: the
 * editor writes to it from an async callback and the publish form reads it at
 * submit, and neither event should re-render the page under the writer.
 */
export function createInlineImageStore() {
  const blobs = new Map<string, unknown>();
  const previews = new Map<string, string>();

  return {
    /** Remember an upload, and the local bytes to show until it publishes. */
    remember(uploaded: UploadedInlineImage, previewUrl?: string) {
      blobs.set(uploaded.url, uploaded.blob);
      if (previewUrl) previews.set(uploaded.url, previewUrl);
    },
    /**
     * Take on the blobs a previous session already uploaded for this draft.
     *
     * The store is per-mount, so without this a resumed draft submits an empty
     * `images` field and the record references none of its own pictures — the
     * PDS then reclaims them, and the post goes live with images that can
     * never come back. Keyed by cid rather than by url because that is what
     * the stored form carries and what the server matches on; a re-upload of
     * the same bytes therefore collapses onto one entry instead of two.
     */
    adopt(stored: readonly unknown[]) {
      for (const blob of stored) {
        const cid =
          typeof blob === "object" && blob !== null
            ? (blob as { ref?: { $link?: unknown } }).ref?.$link
            : undefined;
        if (typeof cid === "string" && !blobs.has(cid)) blobs.set(cid, blob);
      }
    },
    /** What the editor should DISPLAY for a stored URL. */
    display(url: string): string {
      return previews.get(url) ?? url;
    },
    /** The publish form's `images` field. The server keeps only the blobs the
     * submitted body still references, so sending everything is correct. */
    toField(): string {
      const values = [...blobs.values()];
      return values.length > 0 ? JSON.stringify(values) : "";
    },
    get size(): number {
      return blobs.size;
    },
    /** Object URLs are process-lifetime leaks otherwise. */
    dispose() {
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
    },
  };
}

export type UploadStatus = { tone: "info" | "error"; message: string };

export type UploaderOptions = {
  /** Read at call time: the editor keeps its store in a ref so the handler
   * identity can stay stable across renders. */
  store: () => InlineImageStore | undefined;
  onStatus: (status: UploadStatus) => void;
  /** Injectable for tests. */
  upload?: (file: File) => Promise<UploadedInlineImage>;
  /** Shrinks an oversized image to the blob cap before it is sent. Defaults
   * to the same downscale the cover picker uses — identical output contract
   * (≤1600px longest side, ≤1MB, raster), so there is no second copy of it. */
  prepare?: (file: File) => Promise<File>;
  previewUrl?: (file: File) => string | undefined;
};

/**
 * The editor's `uploadFile` handler.
 *
 * It NEVER rejects. BlockNote awaits this without a catch on the drop and
 * paste paths, so a rejection would become an unhandled promise and leave the
 * writer with a silent empty block. Instead every failure reports its reason
 * through `onStatus` and answers an empty patch, which leaves the placeholder
 * block where the writer put it — visible, and retryable in place.
 */
export function createInlineImageUploader(options: UploaderOptions) {
  const upload = options.upload ?? ((file: File) => uploadInlineImage(file));
  const prepare = options.prepare ?? downscaleImage;
  const previewUrl = options.previewUrl ?? safeObjectUrl;

  return async function uploadFile(
    file: File,
  ): Promise<Record<string, unknown>> {
    const store = options.store();
    if (!store) {
      options.onStatus({
        tone: "error",
        message: "Sign in again to add images.",
      });
      return {};
    }
    // Broad on purpose, matching the cover picker: the downscale below
    // re-encodes anything the browser can decode but the server won't take
    // (HEIC off a phone, BMP, TIFF) to JPEG, so gating on the strict raster
    // allowlist here would refuse files that would have worked.
    if (!file.type.startsWith("image/")) {
      options.onStatus({
        tone: "error",
        message: UPLOAD_ERROR_MESSAGES.image_type,
      });
      return {};
    }

    options.onStatus({ tone: "info", message: "Adding the image…" });

    // workerd has no canvas, so an over-cap image can only be shrunk here.
    // A file that cannot be decoded says so — it never vanishes quietly.
    let sending: File;
    try {
      sending = await prepare(file);
    } catch {
      options.onStatus({ tone: "error", message: DOWNSCALE_ERROR });
      return {};
    }
    const shrunk = downscaleNotice(file.size, sending.size);

    try {
      const uploaded = await upload(sending);
      // The proxy path is what gets stored and published; the local bytes are
      // what the editor can actually show, because the PDS will not serve the
      // blob until the record referencing it exists.
      store.remember(uploaded, previewUrl(sending));
      options.onStatus({
        tone: "info",
        message: `${shrunk ? `${shrunk} ` : ""}Image added to your repo. Give it alt text so screen readers can describe it.`,
      });
      return { props: { url: uploaded.url } };
    } catch (err) {
      options.onStatus({
        tone: "error",
        message: err instanceof Error ? err.message : GENERIC_UPLOAD_ERROR,
      });
      return {};
    }
  };
}

/** jsdom (and a locked-down browser) can refuse object URLs; a missing
 * preview is a blank image, not a failed upload. */
function safeObjectUrl(file: File): string | undefined {
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

/** The shape of a BlockNote block this module needs — kept structural so the
 * inspections below can run on stored draft JSON too. */
type BlockLike = {
  type?: unknown;
  props?: Record<string, unknown> | undefined;
  children?: unknown;
};

function walkBlocks(
  blocks: readonly unknown[],
  visit: (block: BlockLike) => void,
): void {
  for (const raw of blocks) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as BlockLike;
    visit(block);
    if (Array.isArray(block.children)) walkBlocks(block.children, visit);
  }
}

/**
 * Images carrying no alt text. BlockNote stores it in the image block's `name`
 * prop (the same value it writes as the `alt` attribute, and as the `![alt]`
 * text on markdown export), which is why the editor relabels its "Rename
 * image" control as the alt-text field.
 */
export function imagesMissingAltText(blocks: readonly unknown[]): number {
  let missing = 0;
  walkBlocks(blocks, (block) => {
    if (block.type !== "image") return;
    const url = block.props?.url;
    if (typeof url !== "string" || url === "") return; // empty placeholder
    const name = block.props?.name;
    if (typeof name !== "string" || name.trim() === "") missing += 1;
  });
  return missing;
}

/**
 * Images still hosted somewhere else. On an imported draft these are exactly
 * the ones publishing will copy into the writer's repo (see rehostBodyImages
 * in ~/lib/import), which is what the write page warns about beforehand.
 */
export function countRemoteImages(blocks: readonly unknown[]): number {
  let remote = 0;
  walkBlocks(blocks, (block) => {
    if (block.type !== "image") return;
    const url = block.props?.url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) remote += 1;
  });
  return remote;
}

/** Does this document carry images served through our own blob proxy? Used to
 * warn on a resumed draft, whose images cannot render until it publishes. */
export function hasProxiedImages(blocks: readonly unknown[]): boolean {
  let found = false;
  walkBlocks(blocks, (block) => {
    const url = block.props?.url;
    if (typeof url === "string" && url.startsWith("/img/")) found = true;
  });
  return found;
}
