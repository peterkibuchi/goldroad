/**
 * Client-side image preparation for the pickers: cover images on /write,
 * publication icons on /settings. Runs in the browser only (canvas +
 * createImageBitmap); the server re-enforces the lexicon caps regardless
 * (never trust the client, even our own).
 *
 * Output contract: a raster file within MAX_COVER_BYTES, longest side at
 * most MAX_COVER_DIMENSION. Files already within both bounds pass through
 * untouched (no needless recompression); everything else re-encodes to JPEG
 * on a white background (covers sit on paper-white; JPEG encodes everywhere,
 * unlike webp/avif).
 */

import { isAllowedImageMime } from "~/lib/blob";

/** Longest-side ceiling — plenty for a reading column + og:image cards. */
export const MAX_COVER_DIMENSION = 1600;

/** The lexicon cap for site.standard.document#coverImage. */
export const MAX_COVER_BYTES = 1_000_000;

/** Pure: fit (width, height) inside a maxDim square, preserving aspect
 * ratio, never upscaling, never returning a zero dimension. */
export function fitWithin(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Publication icons are square; the lexicon asks for at least 256×256, and
 * 512 stays crisp on a retina masthead without spending the byte budget. */
export const MAX_ICON_DIMENSION = 512;

/** Pure: the largest centred square inside (width, height) — the crop an
 * off-square upload gets, so the writer sees the middle of their image
 * rather than a stretched one. */
export function centerSquare(
  width: number,
  height: number,
): { x: number; y: number; size: number } {
  const size = Math.max(1, Math.min(width, height));
  return {
    x: Math.round((width - size) / 2),
    y: Math.round((height - size) / 2),
    size,
  };
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

/**
 * Downscales/recompresses a picked image to the cover contract. Throws when
 * the browser can't decode the file (corrupt, or an exotic type like SVG
 * without intrinsic size) — the caller shows a "try a JPEG or PNG" message.
 */
export async function downscaleImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    // Pass-through only for types the server accepts (adopted from review):
    // a decodable-but-unsupported format (BMP, TIFF, HEIC — and SVG, which
    // must never reach the server) re-encodes to JPEG instead of bouncing
    // off the server's allowlist after upload.
    const fitsAlready =
      file.size <= MAX_COVER_BYTES &&
      Math.max(bitmap.width, bitmap.height) <= MAX_COVER_DIMENSION &&
      isAllowedImageMime(file.type);
    if (fitsAlready) return file;

    const canvas = document.createElement("canvas");
    let { width, height } = fitWithin(
      bitmap.width,
      bitmap.height,
      MAX_COVER_DIMENSION,
    );
    // Descend through qualities, then dimensions, until under the byte cap.
    // Three dimension passes bottom out around 780px — plenty small for any
    // real photograph to fit 1MB at q0.6.
    for (let pass = 0; pass < 3; pass++) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      // JPEG has no alpha — composite transparency onto paper white.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.85, 0.75, 0.6]) {
        const blob = await encodeCanvas(canvas, quality);
        if (blob && blob.size <= MAX_COVER_BYTES) {
          const name = file.name.replace(/\.[^.]*$/, "") || "cover";
          return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
        }
      }
      ({ width, height } = fitWithin(
        width,
        height,
        Math.round(Math.max(width, height) * 0.7),
      ));
    }
    throw new Error("could not compress image under the size limit");
  } finally {
    bitmap.close();
  }
}

/**
 * Prepares a picked image as a publication icon: centre-cropped to a square,
 * capped at MAX_ICON_DIMENSION and the 1MB blob limit. A file that is already
 * square, small enough and of a type the server accepts passes through
 * untouched — which is how a transparent PNG logo keeps its transparency.
 * Anything else re-encodes to JPEG on white (icons sit on paper).
 *
 * Throws when the browser can't decode the file; the caller shows a "try a
 * JPEG or PNG" message.
 */
export async function squareIconImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const isSquare = bitmap.width === bitmap.height;
    if (
      isSquare &&
      file.size <= MAX_COVER_BYTES &&
      bitmap.width <= MAX_ICON_DIMENSION &&
      isAllowedImageMime(file.type)
    )
      return file;

    const crop = centerSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    let side = Math.min(crop.size, MAX_ICON_DIMENSION);
    // Same descent as the cover path: qualities first, then dimensions.
    for (let pass = 0; pass < 3; pass++) {
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, side, side);
      ctx.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.size,
        crop.size,
        0,
        0,
        side,
        side,
      );
      for (const quality of [0.9, 0.8, 0.7]) {
        const blob = await encodeCanvas(canvas, quality);
        if (blob && blob.size <= MAX_COVER_BYTES) {
          const name = file.name.replace(/\.[^.]*$/, "") || "icon";
          return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
        }
      }
      side = Math.max(1, Math.round(side * 0.7));
    }
    throw new Error("could not compress image under the size limit");
  } finally {
    bitmap.close();
  }
}
