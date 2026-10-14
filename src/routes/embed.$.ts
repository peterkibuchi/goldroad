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
 * its referrer is our origin alone, nothing about the post it sat in.
 *
 * Opened directly rather than in a frame, the page sends the reader to the
 * provider's own page instead: it is a frame for our posts, not a player for
 * anyone's link.
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
  originalUrl,
  PLAYER_ORIGINS,
  parseFramePath,
  playerUrl,
} from "~/lib/embeds";

/** Hands keyboard focus to the player as soon as it exists: the reader's
 * click focused this frame, and their next key (Space to pause) is for the
 * player inside it. */
const FOCUS_PLAYER = `document.querySelector("iframe").focus();`;

/** Forwards the Bluesky player's reported height, clamped by the parent. */
const HEIGHT_RELAY = `addEventListener("message",function(e){if(e.origin!=="${PLAYER_ORIGINS.bluesky}"||!e.data||typeof e.data.height!=="number")return;parent.postMessage({goldroadEmbedHeight:e.data.height},location.origin)});`;

/** The page's one script, and its hash for script-src: the text can't change
 * without the policy changing with it. */
const scriptHashes = new Map<string, Promise<string>>();
function hashOf(script: string): Promise<string> {
  let hash = scriptHashes.get(script);
  if (!hash) {
    hash = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(script))
      .then(
        (digest) =>
          `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`,
      );
    scriptHashes.set(script, hash);
  }
  return hash;
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
        // The router has already decoded the splat once.
        const segments = (params._splat ?? "").split("/").filter(Boolean);
        const embed = parseFramePath(segments, url.searchParams);
        if (!embed) return unavailable(null);
        // Browsers say where a request is headed; only a frame gets a player.
        const dest = request.headers.get("sec-fetch-dest");
        if (dest && dest !== "iframe")
          return Response.redirect(originalUrl(embed), 303);

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
        const script =
          embed.provider === "bluesky"
            ? FOCUS_PLAYER + HEIGHT_RELAY
            : FOCUS_PLAYER;
        return page(
          `${player}<script>${script}</script>`,
          frameCsp(PLAYER_ORIGINS[embed.provider], await hashOf(script)),
          200,
          // A handle can move to another account; don't hold the answer long.
          embed.provider === "bluesky" ? 3_600 : 86_400,
        );
      },
    },
  },
});
