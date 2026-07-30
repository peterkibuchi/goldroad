// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  bucketForReferrer,
  bucketReferrers,
  MAX_OTHER_DOMAINS,
  normalizeDomain,
} from "../lib/referrers";

describe("normalizeDomain — the cosmetic differences that split one source", () => {
  it("lowercases, drops a trailing root dot, and drops a leading www.", () => {
    expect(normalizeDomain("WWW.Google.CO.UK.")).toBe("google.co.uk");
    expect(normalizeDomain("  BSKY.app  ")).toBe("bsky.app");
  });

  it("treats absent and empty as absent", () => {
    for (const value of [undefined, null, "", "   ", ".", 42, {}]) {
      expect(normalizeDomain(value)).toBeNull();
    }
  });
});

describe("bucketForReferrer — dot-boundary matching, first match wins", () => {
  it("sends absent, empty and PostHog's sentinel to Direct or unknown", () => {
    for (const value of [undefined, null, "", "$direct", 0, {}]) {
      expect(bucketForReferrer(value)).toBe("direct");
    }
  });

  it("recognizes Bluesky's own client and its subdomains", () => {
    expect(bucketForReferrer("bsky.app")).toBe("bluesky");
    expect(bucketForReferrer("staging.bsky.app")).toBe("bluesky");
    expect(bucketForReferrer("main.bsky.dev")).toBe("bluesky");
  });

  it("recognizes third-party network clients", () => {
    for (const domain of [
      "deer.social",
      "ouranos.app",
      "graysky.app",
      "tokimeki.blue",
    ]) {
      expect(bucketForReferrer(domain)).toBe("bluesky");
    }
  });

  it("refuses lookalikes — this is the whole point of matching at a dot", () => {
    // A substring test would credit both of these to Bluesky.
    expect(bucketForReferrer("bsky.app.evil.example")).toBe("other");
    expect(bucketForReferrer("notbsky.app")).toBe("other");
    expect(bucketForReferrer("mybsky.app")).toBe("other");
  });

  it("recognizes search engines across case, www, trailing dot and ccTLD", () => {
    for (const domain of [
      "WWW.Google.CO.UK.",
      "google.com",
      "news.google.com",
      "google.com.br",
      "duckduckgo.com",
      "search.brave.com",
      "bing.com",
      "ecosia.org",
      "kagi.com",
      "yandex.com.tr",
      "baidu.com",
      "search.marginalia.nu",
    ]) {
      expect(bucketForReferrer(domain)).toBe("search");
    }
  });

  it("does not mistake a long label after a search brand for a ccTLD", () => {
    expect(bucketForReferrer("google.android.gm")).toBe("other");
  });

  it("sends social and aggregator referrers to Other sites", () => {
    for (const domain of [
      "t.co",
      "lm.facebook.com",
      "news.ycombinator.com",
      "reddit.com",
      "out.reddit.com",
    ]) {
      expect(bucketForReferrer(domain)).toBe("other");
    }
  });

  it("recognizes our own origins as within-your-site navigation", () => {
    expect(bucketForReferrer("trygoldroad.com")).toBe("internal");
    expect(bucketForReferrer("x.goldroad.pub")).toBe("internal");
    expect(bucketForReferrer("goldroad.kibuchi.workers.dev")).toBe("internal");
    // A lookalike of our own apex is not ours either.
    expect(bucketForReferrer("goldroad.pub.evil.example")).toBe("other");
  });

  it("handles app schemes and punycode without throwing", () => {
    expect(bucketForReferrer("android-app://com.google.android.gm")).toBe(
      "other",
    );
    expect(bucketForReferrer("xn--80ak6aa92e.com")).toBe("other");
    expect(bucketForReferrer("bsky.app:8443")).toBe("other");
  });
});

describe("bucketReferrers — the tail is reconciled, never dropped", () => {
  it("sums bucketed domains and sorts by views descending", () => {
    const result = bucketReferrers(
      [
        { domain: "bsky.app", views: 60 },
        { domain: "$direct", views: 25 },
        { domain: "google.com", views: 10 },
        { domain: "t.co", views: 5 },
      ],
      100,
    );
    expect(result.buckets).toEqual([
      { bucket: "bluesky", views: 60 },
      { bucket: "direct", views: 25 },
      { bucket: "search", views: 10 },
      { bucket: "other", views: 5 },
    ]);
  });

  it("adds the domains past the query's limit to Other sites, exactly", () => {
    // The top-N rows account for 90; the authoritative total is 100.
    const result = bucketReferrers(
      [
        { domain: "bsky.app", views: 60 },
        { domain: "$direct", views: 30 },
      ],
      100,
    );
    const other = result.buckets.find((b) => b.bucket === "other");
    expect(other).toEqual({ bucket: "other", views: 10 });
    // And the buckets add up to the total, so percentages can reach 100.
    expect(result.buckets.reduce((n, b) => n + b.views, 0)).toBe(100);
  });

  it("never invents a negative tail when the totals disagree at the edge", () => {
    const result = bucketReferrers([{ domain: "bsky.app", views: 60 }], 40);
    expect(result.buckets.every((b) => b.views >= 0)).toBe(true);
    expect(result.total).toBe(40);
  });

  it("omits zero-count buckets rather than drawing empty rows", () => {
    const result = bucketReferrers([{ domain: "bsky.app", views: 10 }], 10);
    expect(result.buckets).toEqual([{ bucket: "bluesky", views: 10 }]);
  });

  it("names the top Other domains, capped, most traffic first", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      domain: `site${i}.example`,
      views: i + 1,
    }));
    const result = bucketReferrers(rows, 36);
    expect(result.topOtherDomains).toHaveLength(MAX_OTHER_DOMAINS);
    expect(result.topOtherDomains[0]).toEqual({
      domain: "site7.example",
      views: 8,
    });
  });

  it("drops rows with an unusable count instead of failing the breakdown", () => {
    const result = bucketReferrers(
      [
        { domain: "bsky.app", views: 10 },
        { domain: "google.com", views: "twelve" },
        { domain: "t.co", views: -3 },
        { domain: "bing.com", views: Number.NaN },
      ],
      10,
    );
    expect(result.buckets).toEqual([{ bucket: "bluesky", views: 10 }]);
  });

  it("falls back to the bucketed sum when no authoritative total is given", () => {
    const result = bucketReferrers([{ domain: "bsky.app", views: 7 }], 0);
    expect(result.total).toBe(7);
  });
});
