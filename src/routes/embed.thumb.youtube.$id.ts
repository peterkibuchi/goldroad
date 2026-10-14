/**
 * A YouTube video's thumbnail, from our own origin: the preview of an embedded
 * video shows its picture without the reader's browser contacting Google
 * before they press play (~/lib/embeds).
 *
 * The upstream host is fixed and the id is checked against YouTube's id
 * shape, so this can't be pointed anywhere else. The body is a JPEG or
 * nothing, read under a cap, served with nosniff and a no-execution policy,
 * and kept in the Workers cache for a week: one upstream fetch per video per
 * colo, however many readers open the post.
 */
import { createFileRoute } from "@tanstack/react-router";

import { readBodyCapped } from "~/lib/blob";
import { defaultCache } from "~/lib/workers-cache";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** hqdefault is 480×360 and measures 15–40 KB; anything far past that isn't
 * the thumbnail we asked for. */
const MAX_THUMB_BYTES = 256 * 1024;

const NOT_FOUND = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });

export const Route = createFileRoute("/embed/thumb/youtube/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!YOUTUBE_ID.test(params.id)) return NOT_FOUND();
        const cacheKey = new URL(request.url);
        cacheKey.search = "";
        const cache = defaultCache();
        const cached = await cache?.match(cacheKey).catch(() => undefined);
        if (cached) return cached;

        const upstream = await fetch(
          `https://i.ytimg.com/vi/${params.id}/hqdefault.jpg`,
          { redirect: "manual", signal: AbortSignal.timeout(5_000) },
        ).catch(() => null);
        if (
          !upstream?.ok ||
          upstream.headers.get("content-type")?.split(";")[0].trim() !==
            "image/jpeg"
        ) {
          await upstream?.body?.cancel().catch(() => {});
          return NOT_FOUND();
        }
        const bytes = await readBodyCapped(upstream, MAX_THUMB_BYTES);
        if (!bytes) return NOT_FOUND();

        const response = new Response(bytes, {
          headers: {
            "cache-control": "public, max-age=604800",
            "content-type": "image/jpeg",
            "content-security-policy": "default-src 'none'",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          },
        });
        await cache?.put(cacheKey, response.clone()).catch(() => {});
        return response;
      },
    },
  },
});
