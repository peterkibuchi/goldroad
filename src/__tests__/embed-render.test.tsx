import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Embeds on the reading page, and their absence from the feed. The promise is
 * that nothing loads from a provider until the reader presses play: every
 * `src` the page renders is our own, and the player appears only on a click.
 */
import { Prose } from "../components/prose";
import { markdownToHtml, renderBodies } from "../lib/markdown-html";

afterEach(cleanup);

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30";
const page = (md: string) => markdownToHtml(md, { embeds: true });

/** Every URL the browser would fetch on load: src, srcset, poster. */
function loadedUrls(html: string): string[] {
  return [...html.matchAll(/\s(?:src|srcset|poster)="([^"]*)"/g)].map(
    (m) => m[1],
  );
}

describe("the renderer", () => {
  it("turns a bare link alone on its line into a preview that links to the original", () => {
    const html = page(`Before.\n\n${YT}\n\nAfter.`);
    expect(html).toContain('data-embed="youtube"');
    expect(html).toContain(
      'href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=30"',
    );
    expect(html).toContain(
      'data-embed-frame="/embed/youtube/dQw4w9WgXcQ?start=30"',
    );
  });

  it("asks nothing of a provider before the click", () => {
    const html = page(
      [
        YT,
        "https://vimeo.com/76979871",
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
        "https://bsky.app/profile/alice.example/post/3l6oveex3ii2l",
      ].join("\n\n"),
    );
    expect(html.match(/<figure/g)).toHaveLength(4);
    for (const url of loadedUrls(html)) expect(url.startsWith("/")).toBe(true);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<script");
  });

  it("accepts an <autolink> line, the same as a bare URL", () => {
    expect(page(`<${YT}>`)).toContain("<figure");
  });

  it("leaves every other link a link", () => {
    for (const md of [
      `[watch this](${YT})`, // the writer chose words
      `Look: ${YT}`, // part of a sentence
      `- ${YT}`, // in a list
      `> ${YT}`, // in a quote
      `${YT} ${YT}`, // two on a line
      "https://example.com/video", // not a provider
    ])
      expect(page(md)).not.toContain("<figure");
  });

  it("keeps the feed's copy a plain link", () => {
    const feed = markdownToHtml(YT);
    expect(feed).not.toContain("<figure");
    expect(feed).toContain(`<a href="${YT.replace("&", "&amp;")}"`);
  });

  it("caches the page's render and the feed's apart", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("caches", {
      default: {
        match: async (key: string) =>
          store.has(key) ? new Response(store.get(key)) : undefined,
        put: async (key: string, res: Response) => {
          store.set(key, await res.text());
        },
      },
    });
    try {
      const [onPage] = await renderBodies([YT], undefined, { embeds: true });
      const [inFeed] = await renderBodies([YT]);
      expect(onPage).toContain("<figure");
      expect(inFeed).not.toContain("<figure");
      expect(store.size).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Prose — loading a player", () => {
  function mount(md: string) {
    const { container } = render(<Prose html={page(md)} />);
    return container;
  }

  it("swaps the preview for our frame page when clicked", () => {
    const container = mount(YT);
    const preview = container.querySelector(
      "a[data-embed-frame]",
    ) as HTMLElement;
    fireEvent.click(preview);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      "/embed/youtube/dQw4w9WgXcQ?start=30",
    );
    expect(frame?.title).toBe("YouTube video");
    expect(frame?.style.aspectRatio).toBe("16 / 9");
    expect(container.querySelector("a[data-embed-frame]")).toBeNull();
    expect(document.activeElement).toBe(frame);
  });

  it("leaves a click meant for a new tab to the browser", () => {
    const container = mount(YT);
    const preview = container.querySelector(
      "a[data-embed-frame]",
    ) as HTMLElement;
    fireEvent.click(preview, { metaKey: true });
    fireEvent.click(preview, { ctrlKey: true });
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("never frames a path that isn't our own frame page", () => {
    const { container } = render(
      <Prose html='<a data-embed-frame="https://evil.example/" href="https://evil.example/">x</a>' />,
    );
    fireEvent.click(container.querySelector("a") as HTMLElement);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("takes a Bluesky post's height only from its own frame", () => {
    const container = mount(
      "https://bsky.app/profile/alice.example/post/3l6oveex3ii2l",
    );
    fireEvent.click(
      container.querySelector("a[data-embed-frame]") as HTMLElement,
    );
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.style.height).toBe("240px");

    const post = (data: unknown, origin: string, source: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source: source as Window }),
      );
    post(
      { goldroadEmbedHeight: 512 },
      "https://evil.example",
      frame.contentWindow,
    );
    post({ goldroadEmbedHeight: 512 }, window.location.origin, window);
    expect(frame.style.height).toBe("240px");
    post(
      { goldroadEmbedHeight: 512 },
      window.location.origin,
      frame.contentWindow,
    );
    expect(frame.style.height).toBe("512px");
    post(
      { goldroadEmbedHeight: 1e9 },
      window.location.origin,
      frame.contentWindow,
    );
    expect(frame.style.height).toBe("4000px");
  });
});
