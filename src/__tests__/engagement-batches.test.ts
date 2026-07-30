// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  chunkUris,
  fetchEngagementBatches,
  MAX_ENGAGEMENT_BATCHES,
  MAX_GET_POSTS_BATCH,
  mapGetPostsResponse,
} from "../lib/engagement";

const uri = (n: number) => `at://did:plc:aaaa/app.bsky.feed.post/${n}`;
const uris = (count: number) => Array.from({ length: count }, (_, i) => uri(i));

describe("chunkUris — the lexicon's hard limit", () => {
  it("never emits a chunk larger than the AppView accepts", () => {
    const chunks = chunkUris(uris(60));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= MAX_GET_POSTS_BATCH)).toBe(true);
    expect(chunks[2]).toHaveLength(10);
  });

  it("caps an over-large requested size at the lexicon limit", () => {
    expect(chunkUris(uris(30), 100)[0]).toHaveLength(MAX_GET_POSTS_BATCH);
  });

  it("never loops forever on a nonsense size", () => {
    expect(chunkUris(uris(3), 0)).toHaveLength(3);
  });

  it("returns nothing for nothing", () => {
    expect(chunkUris([])).toEqual([]);
  });
});

describe("mapGetPostsResponse — joined BY URI, never by index", () => {
  it("attributes counts to the right post when the response is REORDERED", () => {
    // This is the test an index-based join fails. getPosts may answer in any
    // order, and attributing one post's likes to another would be silent.
    const requested = [uri(0), uri(1), uri(2)];
    const byUri = mapGetPostsResponse(
      {
        posts: [
          { uri: uri(2), likeCount: 300 },
          { uri: uri(0), likeCount: 100 },
          { uri: uri(1), likeCount: 200 },
        ],
      },
      requested,
    );
    expect(byUri.get(uri(0))).toMatchObject({ likeCount: 100 });
    expect(byUri.get(uri(1))).toMatchObject({ likeCount: 200 });
    expect(byUri.get(uri(2))).toMatchObject({ likeCount: 300 });
  });

  it("marks a URI that didn't come back as gone, explicitly", () => {
    // Deleted, blocked or taken down on Bluesky: the AppView simply omits it.
    const byUri = mapGetPostsResponse(
      { posts: [{ uri: uri(0), likeCount: 1 }] },
      [uri(0), uri(1)],
    );
    expect(byUri.get(uri(1))).toBe("gone");
  });

  it("ignores URIs in the response that nobody asked about", () => {
    const byUri = mapGetPostsResponse(
      {
        posts: [
          { uri: uri(0), likeCount: 1 },
          {
            uri: "at://did:plc:someone-else/app.bsky.feed.post/x",
            likeCount: 9,
          },
        ],
      },
      [uri(0)],
    );
    expect(byUri.size).toBe(1);
    expect(byUri.has("at://did:plc:someone-else/app.bsky.feed.post/x")).toBe(
      false,
    );
  });

  it("keeps an omitted count undefined rather than coalescing it to zero", () => {
    const byUri = mapGetPostsResponse({ posts: [{ uri: uri(0) }] }, [uri(0)]);
    expect(byUri.get(uri(0))).toEqual({
      likeCount: undefined,
      replyCount: undefined,
      repostCount: undefined,
      quoteCount: undefined,
    });
  });

  it("drops counts that aren't real non-negative numbers", () => {
    const byUri = mapGetPostsResponse(
      {
        posts: [
          {
            uri: uri(0),
            likeCount: "12",
            replyCount: -3,
            repostCount: Number.NaN,
            quoteCount: Number.POSITIVE_INFINITY,
          },
        ],
      },
      [uri(0)],
    );
    expect(byUri.get(uri(0))).toEqual({
      likeCount: undefined,
      replyCount: undefined,
      repostCount: undefined,
      quoteCount: undefined,
    });
  });

  it("survives every hostile body shape by marking everything gone", () => {
    for (const body of [
      null,
      undefined,
      {},
      { posts: "nope" },
      { posts: [null, 7] },
      [],
    ]) {
      const byUri = mapGetPostsResponse(body, [uri(0)]);
      expect(byUri.get(uri(0))).toBe("gone");
    }
  });
});

/** An AppView stub that answers with the URIs it was asked for. */
function stubAppView(
  handler: (batch: string[], call: number) => Response | Promise<Response>,
) {
  let call = 0;
  return vi.fn(async (input: string) => {
    const batch = new URL(String(input)).searchParams.getAll("uris");
    return handler(batch, call++);
  });
}

function okBody(batch: string[]) {
  return new Response(
    JSON.stringify({ posts: batch.map((u) => ({ uri: u, likeCount: 1 })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("fetchEngagementBatches — partial failure is reported, not hidden", () => {
  it("chunks 26 URIs into two calls, never one over-large call", async () => {
    const fetcher = stubAppView((batch) => okBody(batch));
    const result = await fetchEngagementBatches({
      uris: uris(26),
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.requested).toBe(26);
    expect(result.answered).toBe(26);
  });

  it("caps the number of calls, so one page load can't crawl an archive", async () => {
    const fetcher = stubAppView((batch) => okBody(batch));
    const result = await fetchEngagementBatches({
      uris: uris(500),
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(MAX_ENGAGEMENT_BATCHES);
    expect(result.requested).toBe(MAX_ENGAGEMENT_BATCHES * MAX_GET_POSTS_BATCH);
  });

  it("counts only the URIs from batches that answered", async () => {
    const fetcher = stubAppView((batch, call) =>
      call === 1 ? new Response("{}", { status: 503 }) : okBody(batch),
    );
    const result = await fetchEngagementBatches({
      uris: uris(30),
      fetcher: fetcher as unknown as typeof fetch,
      // Sequential, so "the second batch" is deterministic in this test.
      maxBatches: 2,
    });
    expect(result.requested).toBe(30);
    expect(result.answered).toBe(25);
    // A failed batch leaves its URIs ABSENT — which is a different fact from
    // present-and-gone: we couldn't look, rather than looked and found nothing.
    expect(result.byUri.has(uri(0))).toBe(true);
    expect(result.byUri.has(uri(26))).toBe(false);
  });

  it("degrades a non-JSON body to a failed batch rather than throwing", async () => {
    const fetcher = stubAppView(
      () => new Response("<html>gateway error</html>", { status: 200 }),
    );
    const result = await fetchEngagementBatches({
      uris: uris(3),
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.answered).toBe(0);
    expect(result.byUri.size).toBe(0);
  });

  it("degrades an oversized body to a failed batch", async () => {
    const huge = JSON.stringify({
      posts: [{ uri: uri(0), bio: "x".repeat(300_000) }],
    });
    const fetcher = stubAppView(
      () =>
        new Response(huge, {
          status: 200,
          headers: { "content-length": String(huge.length) },
        }),
    );
    const result = await fetchEngagementBatches({
      uris: [uri(0)],
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.answered).toBe(0);
  });

  it("degrades a timeout to a failed batch", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await fetchEngagementBatches({
      uris: [uri(0)],
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.answered).toBe(0);
    expect(result.byUri.size).toBe(0);
  });

  it("ignores anything that isn't an at:// URI without spending a call", async () => {
    const fetcher = stubAppView((batch) => okBody(batch));
    const result = await fetchEngagementBatches({
      uris: ["https://bsky.app/profile/x", "", "at:/malformed"],
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.requested).toBe(0);
  });
});
