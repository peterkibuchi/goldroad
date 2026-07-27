/**
 * Client-side cover-image downscaling for the /write picker. Runs in the
 * browser only (canvas + createImageBitmap); the server re-enforces the
 * lexicon caps regardless (never trust the client, even our own).
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
