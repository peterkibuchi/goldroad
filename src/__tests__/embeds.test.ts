// @vitest-environment node
/**
 * Which links become embeds, and what each one loads when played. Strict on
 * purpose: everything parseEmbed accepts ends up in a player URL on a frame
 * page, so a lookalike host or a malformed id must fall through to a plain
 * link.
 */
import { describe, expect, it } from "vitest";

import {
  type Embed,
  framePath,
  PLAYER_ORIGINS,
  parseEmbed,
  parseFramePath,
  playerUrl,
  thumbnailPath,
} from "../lib/embeds";

const YT = "dQw4w9WgXcQ";
const SPOTIFY = "4uLU6hMCjMI75M1A2tKUQC";
const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";

describe("parseEmbed — what qualifies", () => {
  it.each([
    [
      `https://www.youtube.com/watch?v=${YT}`,
      { provider: "youtube", id: YT, start: null },
    ],
    [
      `https://youtube.com/watch?v=${YT}&t=1m30s`,
      { provider: "youtube", id: YT, start: 90 },
    ],
    [
      `https://m.youtube.com/watch?v=${YT}&t=42`,
      { provider: "youtube", id: YT, start: 42 },
    ],
    [`https://youtu.be/${YT}?t=7`, { provider: "youtube", id: YT, start: 7 }],
    [
      `https://www.youtube.com/shorts/${YT}`,
      { provider: "youtube", id: YT, start: null },
    ],
    [
      "https://vimeo.com/76979871",
      { provider: "vimeo", id: "76979871", hash: null },
    ],
    [
      "https://vimeo.com/76979871/abc123def0",
      { provider: "vimeo", id: "76979871", hash: "abc123def0" },
    ],
    [
      "https://player.vimeo.com/video/76979871?h=abc123",
      { provider: "vimeo", id: "76979871", hash: "abc123" },
    ],
    [
      `https://open.spotify.com/track/${SPOTIFY}`,
      { provider: "spotify", kind: "track", id: SPOTIFY },
    ],
    [
      `https://open.spotify.com/intl-de/album/${SPOTIFY}?si=x`,
      { provider: "spotify", kind: "album", id: SPOTIFY },
    ],
    [
      "https://bsky.app/profile/alice.example/post/3l6oveex3ii2l",
      { provider: "bluesky", actor: "alice.example", rkey: "3l6oveex3ii2l" },
    ],
    [
      `https://bsky.app/profile/${DID}/post/3l6oveex3ii2l`,
      { provider: "bluesky", actor: DID, rkey: "3l6oveex3ii2l" },
    ],
  ])("%s", (url, expected) => {
    expect(parseEmbed(url)).toEqual(expected);
  });

  it.each([
    `http://www.youtube.com/watch?v=${YT}`, // not https
    `https://www.youtube.com.evil.example/watch?v=${YT}`, // lookalike host
    `https://evilyoutube.com/watch?v=${YT}`,
    `https://user:pw@www.youtube.com/watch?v=${YT}`,
    "https://www.youtube.com/watch?v=short", // not an id
    `https://www.youtube.com/watch?v=${YT}"><script>`,
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/embed/videoseries?list=PL123", // a playlist
    "https://www.youtube.com/embed/live_stream?channel=UC1", // a channel's live slot
    `https://youtu.be/${YT}/extra`,
    "https://vimeo.com/channels/staffpicks",
    "https://vimeo.com/76979871/NOT-A-HASH",
    `https://open.spotify.com/user/${SPOTIFY}`,
    "https://open.spotify.com/track/tooShort",
    "https://bsky.app/profile/alice.example",
    "https://bsky.app/profile/alice.example/post/NOT_A_TID",
    "https://bsky.app/profile/not a handle/post/3l6oveex3ii2l",
    "not a url",
  ])("refuses %s", (url) => {
    expect(parseEmbed(url)).toBeNull();
  });
});

describe("what a played embed loads", () => {
  const samples: Embed[] = [
    { provider: "youtube", id: YT, start: 90 },
    { provider: "vimeo", id: "76979871", hash: "abc123" },
    { provider: "spotify", kind: "playlist", id: SPOTIFY },
    { provider: "bluesky", actor: "alice.example", rkey: "3l6oveex3ii2l" },
  ];

  it("round-trips through the frame page's path, and nothing else does", () => {
    for (const embed of samples) {
      const url = new URL(framePath(embed), "https://trygoldroad.com");
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .slice(1)
        .map(decodeURIComponent);
      expect(parseFramePath(segments, url.searchParams)).toEqual(embed);
    }
    expect(
      parseFramePath(["youtube", YT, "extra"], new URLSearchParams()),
    ).toBeNull();
    expect(parseFramePath(["evil", YT], new URLSearchParams())).toBeNull();
  });

  it("loads only the provider's own player origin, with tracking turned down", () => {
    const youtube = playerUrl(samples[0]) ?? "";
    expect(youtube.startsWith(`${PLAYER_ORIGINS.youtube}/embed/${YT}?`)).toBe(
      true,
    );
    expect(youtube).toContain("start=90");
    expect(PLAYER_ORIGINS.youtube).toBe("https://www.youtube-nocookie.com");
    expect(playerUrl(samples[1])).toBe(
      `${PLAYER_ORIGINS.vimeo}/video/76979871?autoplay=1&dnt=1&h=abc123`,
    );
    expect(playerUrl(samples[2])).toBe(
      `${PLAYER_ORIGINS.spotify}/embed/playlist/${SPOTIFY}`,
    );
  });

  it("needs a DID for a Bluesky post, and builds none from a handle", () => {
    expect(playerUrl(samples[3])).toBeNull();
    expect(playerUrl(samples[3], DID)).toBe(
      `${PLAYER_ORIGINS.bluesky}/embed/${DID}/app.bsky.feed.post/3l6oveex3ii2l?id=post&colorMode=system`,
    );
  });

  it("shows a thumbnail only where it can come from our own origin", () => {
    expect(thumbnailPath(samples[0])).toBe(`/embed/thumb/youtube/${YT}`);
    for (const embed of samples.slice(1))
      expect(thumbnailPath(embed)).toBeNull();
  });
});
