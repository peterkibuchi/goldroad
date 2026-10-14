// @vitest-environment node
/**
 * The frame page a played embed loads, and the thumbnail proxy. The frame's
 * policy is what keeps every other page free of third-party frames, so it is
 * pinned here directive by directive, through the same header pass every
 * response takes (~/lib/security-headers).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const atproto = vi.hoisted(() => ({ resolveHandleToDid: vi.fn() }));
vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/atproto")>()),
  ...atproto,
}));

import { PLAYER_ORIGINS } from "../lib/embeds";
import {
  buildContentSecurityPolicy,
  withSecurityHeaders,
} from "../lib/security-headers";
import { Route as FrameRoute } from "../routes/embed.$";
import { Route as ThumbRoute } from "../routes/embed.thumb.youtube.$id";
import { handlerOf } from "./support/route-handler";

const frame = handlerOf<{ request: Request; params: { _splat: string } }>(
  FrameRoute,
  "GET",
);
const thumb = handlerOf<{ request: Request; params: { id: string } }>(
  ThumbRoute,
  "GET",
);

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";

async function open(path: string) {
  const url = new URL(path, "https://trygoldroad.com");
  const res = await frame({
    request: new Request(url),
    params: { _splat: url.pathname.replace(/^\/embed\//, "") },
  });
  // Through the same pass every page takes, with the site's own policy.
  return withSecurityHeaders(res, buildContentSecurityPolicy());
}

function directives(res: Response): Map<string, string> {
  return new Map(
    (res.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .map(([name, ...values]) => [name, values.join(" ")]),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  atproto.resolveHandleToDid.mockReset();
});

describe("/embed — the frame page", () => {
  it("holds one player and allows that one origin, framed only by our pages", async () => {
    const res = await open("/embed/youtube/dQw4w9WgXcQ?start=30");
    expect(res.status).toBe(200);
    const csp = directives(res);
    expect(csp.get("frame-src")).toBe(PLAYER_ORIGINS.youtube);
    expect(csp.get("frame-ancestors")).toBe("'self'");
    expect(csp.get("default-src")).toBe("'none'");
    expect(csp.has("script-src")).toBe(false);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const html = await res.text();
    expect(html).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&amp;rel=0&amp;start=30"',
    );
    expect(html).toContain('sandbox="allow-scripts allow-same-origin');
    expect(html).not.toContain("allow-top-navigation");
  });

  it("names each provider's own origin, and only that one", async () => {
    for (const [path, origin] of [
      ["/embed/vimeo/76979871", PLAYER_ORIGINS.vimeo],
      ["/embed/spotify/track/4uLU6hMCjMI75M1A2tKUQC", PLAYER_ORIGINS.spotify],
    ]) {
      expect(directives(await open(path)).get("frame-src")).toBe(origin);
    }
  });

  it("resolves a Bluesky handle, and allows exactly the relay script it serves", async () => {
    atproto.resolveHandleToDid.mockResolvedValue(DID);
    const res = await open("/embed/bluesky/alice.example/3l6oveex3ii2l");
    const html = await res.text();
    expect(html).toContain(
      `src="https://embed.bsky.app/embed/${DID}/app.bsky.feed.post/3l6oveex3ii2l?id=post"`,
    );
    const script = /<script>([^<]*)<\/script>/.exec(html)?.[1] ?? "";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(script),
    );
    const hash = Buffer.from(digest).toString("base64");
    expect(directives(res).get("script-src")).toBe(`'sha256-${hash}'`);
    // The relay listens to the Bluesky player and talks only to our origin.
    expect(script).toContain(`e.origin!=="${PLAYER_ORIGINS.bluesky}"`);
    expect(script).toContain("location.origin");
  });

  it("offers the original when a handle can't be resolved", async () => {
    atproto.resolveHandleToDid.mockRejectedValue(new Error("nope"));
    const res = await open("/embed/bluesky/alice.example/3l6oveex3ii2l");
    expect(res.status).toBe(404);
    expect(directives(res).has("frame-src")).toBe(false);
    expect(await res.text()).toContain(
      'href="https://bsky.app/profile/alice.example/post/3l6oveex3ii2l"',
    );
  });

  it("refuses anything it didn't render, and frames nothing for it", async () => {
    for (const path of [
      "/embed/youtube/not-an-id",
      "/embed/evil/dQw4w9WgXcQ",
      "/embed/youtube/dQw4w9WgXcQ/extra",
      "/embed/spotify/user/4uLU6hMCjMI75M1A2tKUQC",
      "/embed/youtube/%E0%A4%A",
    ]) {
      const res = await open(path);
      expect(res.status).toBe(404);
      expect(directives(res).has("frame-src")).toBe(false);
    }
  });
});

describe("the site's own pages", () => {
  it("still deny every frame and name no provider", () => {
    const res = withSecurityHeaders(
      new Response("<p>x</p>", { headers: { "content-type": "text/html" } }),
      buildContentSecurityPolicy(),
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    for (const origin of Object.values(PLAYER_ORIGINS))
      expect(csp).not.toContain(origin);
  });
});

describe("/embed/thumb/youtube — the thumbnail proxy", () => {
  const get = (id: string) =>
    thumb({
      request: new Request(`https://trygoldroad.com/embed/thumb/youtube/${id}`),
      params: { id },
    });

  it("fetches the one fixed host, and only for a real id", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array(100), {
          headers: { "content-type": "image/jpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect((await get("../../etc")).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    const res = await get("dQw4w9WgXcQ");
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
  });

  it("serves nothing that isn't a JPEG", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<svg/>", {
            headers: { "content-type": "image/svg+xml" },
          }),
      ),
    );
    expect((await get("dQw4w9WgXcQ")).status).toBe(404);
  });
});
