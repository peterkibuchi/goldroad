/**
 * Embeds: a link to a YouTube or Vimeo video, a Spotify track or a Bluesky
 * post, alone on its own line, shows on the reading page as a preview the
 * reader clicks to load. Nothing from the provider loads before that click,
 * so reading a post never tells YouTube, Vimeo, Spotify or Bluesky who is
 * reading it.
 *
 * The markdown stays a bare link, so the record reads as the same link in
 * every other app and in RSS. This module is the one place that decides which
 * links qualify and what each provider's player URL is: the renderer
 * (~/lib/markdown-html), the frame route (/embed/…) and the editor's embed
 * block all ask it, so the three can't disagree. Pure: no DOM, no network.
 */
import { isDid, isHandle } from "~/lib/atproto";

export type Embed =
  | { provider: "youtube"; id: string; start: number | null }
  | { provider: "vimeo"; id: string; hash: string | null }
  | { provider: "spotify"; kind: SpotifyKind; id: string }
  | { provider: "bluesky"; actor: string; rkey: string };

export type EmbedProvider = Embed["provider"];

const SPOTIFY_KINDS = [
  "track",
  "album",
  "playlist",
  "episode",
  "show",
  "artist",
] as const;
type SpotifyKind = (typeof SPOTIFY_KINDS)[number];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
/** A Bluesky post's record key (a TID). */
const BSKY_RKEY = /^[a-z2-7]{13}$/;

/** `t=1m30s`, `t=90`, `start=90` → seconds; null when absent or unreadable. */
function startSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
  if (!match || raw === "") return null;
  const [, h, m, s] = match;
  const total = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return total > 0 && total < 86_400 ? total : null;
}

/**
 * The embed a URL points at, or null. Strict on purpose: https only, the
 * providers' own hostnames only, and every id checked against its shape, so
 * anything this returns is safe to build a player URL from.
 */
export function parseEmbed(raw: string): Embed | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const path = url.pathname.split("/").filter(Boolean);

  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id =
      path.length === 1 && path[0] === "watch"
        ? url.searchParams.get("v")
        : path.length === 2 && ["shorts", "embed", "live"].includes(path[0])
          ? path[1]
          : null;
    if (!id || !YOUTUBE_ID.test(id)) return null;
    return {
      provider: "youtube",
      id,
      start: startSeconds(
        url.searchParams.get("t") ?? url.searchParams.get("start"),
      ),
    };
  }
  if (host === "youtu.be") {
    if (path.length !== 1 || !YOUTUBE_ID.test(path[0])) return null;
    return {
      provider: "youtube",
      id: path[0],
      start: startSeconds(url.searchParams.get("t")),
    };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const parts =
      host === "player.vimeo.com" && path[0] === "video" ? path.slice(1) : path;
    const [id, hash] = parts;
    if (parts.length > 2 || !id || !VIMEO_ID.test(id)) return null;
    const h = hash ?? url.searchParams.get("h");
    if (h && !VIMEO_HASH.test(h)) return null;
    return { provider: "vimeo", id, hash: h ?? null };
  }
  if (host === "open.spotify.com") {
    // Localized links carry a leading `intl-xx` segment.
    const parts = path[0]?.startsWith("intl-") ? path.slice(1) : path;
    const [kind, id] = parts;
    if (
      parts.length !== 2 ||
      !(SPOTIFY_KINDS as readonly string[]).includes(kind) ||
      !SPOTIFY_ID.test(id)
    )
      return null;
    return { provider: "spotify", kind: kind as SpotifyKind, id };
  }
  if (host === "bsky.app") {
    const [profile, actor, post, rkey] = path;
    if (path.length !== 4 || profile !== "profile" || post !== "post")
      return null;
    if (!(isDid(actor) || isHandle(actor)) || !BSKY_RKEY.test(rkey))
      return null;
    return { provider: "bluesky", actor, rkey };
  }
  return null;
}

/** Each provider's player origin: the ONE frame-src its frame page allows. */
export const PLAYER_ORIGINS: Record<EmbedProvider, string> = {
  youtube: "https://www.youtube-nocookie.com",
  vimeo: "https://player.vimeo.com",
  spotify: "https://open.spotify.com",
  bluesky: "https://embed.bsky.app",
};

/**
 * The player, inside our own frame page. YouTube's cookieless domain, and
 * Vimeo's do-not-track flag: once a reader has chosen to play, the player
 * still shouldn't follow them around. `autoplay` because the click that
 * loaded it was the reader asking to play. A Bluesky player needs a DID,
 * which the frame route resolves first (`did`).
 */
export function playerUrl(embed: Embed, did?: string): string | null {
  switch (embed.provider) {
    case "youtube": {
      const params = new URLSearchParams({ autoplay: "1", rel: "0" });
      if (embed.start) params.set("start", String(embed.start));
      return `${PLAYER_ORIGINS.youtube}/embed/${embed.id}?${params}`;
    }
    case "vimeo": {
      const params = new URLSearchParams({ autoplay: "1", dnt: "1" });
      if (embed.hash) params.set("h", embed.hash);
      return `${PLAYER_ORIGINS.vimeo}/video/${embed.id}?${params}`;
    }
    case "spotify":
      return `${PLAYER_ORIGINS.spotify}/embed/${embed.kind}/${embed.id}`;
    case "bluesky": {
      const actor = did ?? embed.actor;
      if (!isDid(actor)) return null;
      // `id` is the Bluesky player's own key for the height it reports.
      return `${PLAYER_ORIGINS.bluesky}/embed/${actor}/app.bsky.feed.post/${embed.rkey}?id=post`;
    }
  }
}

/** Our frame page for an embed: the path the reader's click loads. */
export function framePath(embed: Embed): string {
  switch (embed.provider) {
    case "youtube":
      return `/embed/youtube/${embed.id}${embed.start ? `?start=${embed.start}` : ""}`;
    case "vimeo":
      return `/embed/vimeo/${embed.id}${embed.hash ? `/${embed.hash}` : ""}`;
    case "spotify":
      return `/embed/spotify/${embed.kind}/${embed.id}`;
    case "bluesky":
      return `/embed/bluesky/${encodeURIComponent(embed.actor)}/${embed.rkey}`;
  }
}

/** A frame page path back to its embed; null for anything else. The inverse
 * of `framePath`, so the route accepts exactly what the renderer emits. */
export function parseFramePath(
  segments: readonly string[],
  search: URLSearchParams,
): Embed | null {
  const [provider, a, b, ...rest] = segments;
  if (rest.length > 0) return null;
  switch (provider) {
    case "youtube":
      return a && !b && YOUTUBE_ID.test(a)
        ? { provider, id: a, start: startSeconds(search.get("start")) }
        : null;
    case "vimeo":
      return a && VIMEO_ID.test(a) && (!b || VIMEO_HASH.test(b))
        ? { provider, id: a, hash: b ?? null }
        : null;
    case "spotify":
      return a &&
        b &&
        (SPOTIFY_KINDS as readonly string[]).includes(a) &&
        SPOTIFY_ID.test(b)
        ? { provider, kind: a as SpotifyKind, id: b }
        : null;
    case "bluesky":
      return a && b && (isDid(a) || isHandle(a)) && BSKY_RKEY.test(b)
        ? { provider, actor: a, rkey: b }
        : null;
    default:
      return null;
  }
}

/** Our same-origin copy of a YouTube thumbnail, so the preview shows the
 * video without the reader's browser asking Google for it. */
export function thumbnailPath(embed: Embed): string | null {
  return embed.provider === "youtube"
    ? `/embed/thumb/youtube/${embed.id}`
    : null;
}

/** How a preview names what it holds, in the reader's words. */
export function embedLabel(embed: Embed): { provider: string; kind: string } {
  switch (embed.provider) {
    case "youtube":
      return { provider: "YouTube", kind: "Video" };
    case "vimeo":
      return { provider: "Vimeo", kind: "Video" };
    case "spotify": {
      const kinds: Record<SpotifyKind, string> = {
        track: "Song",
        album: "Album",
        playlist: "Playlist",
        episode: "Podcast episode",
        show: "Podcast",
        artist: "Artist",
      };
      return { provider: "Spotify", kind: kinds[embed.kind] };
    }
    case "bluesky":
      return { provider: "Bluesky", kind: "Post" };
  }
}

/**
 * The player's size once loaded. Video keeps 16:9 at any width; Spotify's
 * player has two fixed heights; a Bluesky post reports its own height after it
 * loads (see the frame route), so it starts at a typical post's.
 */
export function playerSize(
  embed: Embed,
): { ratio: string } | { height: number } {
  switch (embed.provider) {
    case "youtube":
    case "vimeo":
      return { ratio: "16 / 9" };
    case "spotify":
      return {
        height: embed.kind === "track" || embed.kind === "episode" ? 152 : 352,
      };
    case "bluesky":
      return { height: 240 };
  }
}
