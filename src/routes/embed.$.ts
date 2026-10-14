/**
 * The frame page a clicked embed loads: a bare document holding one provider
 * player, so the reading page itself never has to allow a third-party frame.
 *
 * Its policy is the point. `frame-src` names exactly one origin, this
 * provider's player (~/lib/embeds' PLAYER_ORIGINS); `frame-ancestors 'self'`
 * lets only our own pages show it; nothing else may load. The reading page's
 * policy already allows same-origin frames, so a post with three embeds has
 * granted no provider anything until a reader presses play on one, and then
 * only inside that one frame.
 *
 * The player is sandboxed (scripts, its own origin, popups for "watch on
 * YouTube", and presentation for fullscreen; never top-level navigation), and
 * the reader's page is not in its referrer: the player sees this frame's URL,
 * which names the video and nothing about the post it sat in.
 *
 * A Bluesky player addresses a post by DID, and a post link usually carries a
 * handle, so the handle is resolved here, at click time, once. The player
 * reports its height to its parent, and the inline script passes that one
 * number up to the reading page (~/components/prose).
 */
import { createFileRoute } from "@tanstack/react-router";

import { resolveHandleToDid } from "~/lib/atproto";
import {
  embedLabel,
  PLAYER_ORIGINS,
  parseFramePath,
  playerUrl,
} from "~/lib/embeds";

/** Forwards the Bluesky player's reported height, clamped by the parent. The
 * text is hashed into the page's script-src, so it can't change silently. */
const HEIGHT_RELAY = `addEventListener("message",function(e){if(e.origin!=="${PLAYER_ORIGINS.bluesky}"||!e.data||typeof e.data.height!=="number")return;parent.postMessage({goldroadEmbedHeight:e.data.height},location.origin)})`;

let relayHash: Promise<string> | null = null;
function heightRelayHash(): Promise<string> {
  relayHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(HEIGHT_RELAY))
    .then(
      (digest) =>
        `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`,
    );
  return relayHash;
}

const STYLE =
  "html,body{margin:0;height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0}p{font:15px/1.5 system-ui,sans-serif;margin:16px}a{color:inherit}";

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function page(
  body: string,
  csp: string,
  status = 200,
  cacheSeconds = 86_400,
): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><style>${STYLE}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        "referrer-policy": "strict-origin",
        "cache-control":
          status === 200 ? `public, max-age=${cacheSeconds}` : "no-store",
      },
    },
  );
}

/** The frame page's policy: one player origin, our pages as the only parent. */
export function frameCsp(playerOrigin: string | null, scriptHash?: string) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "style-src 'unsafe-inline'",
    ...(playerOrigin ? [`frame-src ${playerOrigin}`] : []),
    ...(scriptHash ? [`script-src ${scriptHash}`] : []),
  ].join("; ");
}

/** What the reader sees in the frame when the player can't be built: the way
 * to the original, which opens outside the frame. */
function unavailable(href: string | null): Response {
  return page(
    `<p>This couldn't be loaded here.${href ? ` <a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">Open the original</a>.` : ""}</p>`,
    frameCsp(null),
    404,
  );
}

export const Route = createFileRoute("/embed/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        let segments: string[];
        try {
          segments = (params._splat ?? "")
            .split("/")
            .filter(Boolean)
            .map((part) => decodeURIComponent(part));
        } catch {
          return unavailable(null);
        }
        const embed = parseFramePath(segments, url.searchParams);
        if (!embed) return unavailable(null);

        let did: string | undefined;
        if (embed.provider === "bluesky" && !embed.actor.startsWith("did:")) {
          did = await resolveHandleToDid(embed.actor).catch(() => undefined);
          if (!did)
            return unavailable(
              `https://bsky.app/profile/${encodeURIComponent(embed.actor)}/post/${embed.rkey}`,
            );
        }
        const src = playerUrl(embed, did);
        if (!src) return unavailable(null);

        const { provider, kind } = embedLabel(embed);
        const player = `<iframe src="${escapeAttr(src)}" title="${escapeAttr(`${provider} ${kind.toLowerCase()}`)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"></iframe>`;
        if (embed.provider !== "bluesky")
          return page(player, frameCsp(PLAYER_ORIGINS[embed.provider]));
        return page(
          `${player}<script>${HEIGHT_RELAY}</script>`,
          frameCsp(PLAYER_ORIGINS.bluesky, await heightRelayHash()),
          200,
          // A handle can move to another account; don't hold the answer long.
          3_600,
        );
      },
    },
  },
});
