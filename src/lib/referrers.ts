/**
 * Referring domain → traffic-source bucket.
 *
 * WHY THIS IS TYPESCRIPT AND NOT SQL. The bucketing rules are where traffic
 * analytics quietly lie: a substring match credits `bsky.app.phishing.example`
 * to Bluesky, a forgotten `www.` splits one source into two, and a truncated
 * top-N makes percentages that don't add up. Those are unit-testable
 * properties of a pure function and untestable properties of a CASE expression
 * buried in a query string — so the query returns raw domains and the rules
 * live here, next to their tests.
 *
 * Every match is anchored at a DOT BOUNDARY (`d === s || d.endsWith("." + s)`).
 * That single rule is what keeps a lookalike hostname out of a bucket it hasn't
 * earned.
 */
import { CANONICAL_ORIGIN, LEGACY_ORIGINS } from "~/lib/origin";

export type SourceBucket =
  | "bluesky"
  | "search"
  | "internal"
  | "direct"
  | "other";

/** Display order when counts tie — otherwise buckets sort by views desc. */
export const BUCKET_ORDER: readonly SourceBucket[] = [
  "bluesky",
  "direct",
  "search",
  "internal",
  "other",
];

/** PostHog's sentinel for "no referrer was passed on". */
const DIRECT_SENTINEL = "$direct";

/** Hosts whose traffic is a reader moving around inside the publication they
 * are already reading. Counting these as "Direct" would flatter the direct
 * number with our own archive navigation. */
const INTERNAL_HOSTS: readonly string[] = [
  new URL(CANONICAL_ORIGIN).hostname,
  ...LEGACY_ORIGINS.map((origin) => new URL(origin).hostname),
  // Writer publications live on subdomains of this apex.
  "goldroad.pub",
];

/**
 * Bluesky's own client plus the third-party clients common enough to be worth
 * naming. Best-effort by nature — the network's client ecosystem grows — so an
 * unlisted client lands in "Other sites" rather than being guessed at, and this
 * list wants a periodic read rather than a one-time write.
 */
const BLUESKY_HOSTS: readonly string[] = [
  "bsky.app",
  "bsky.social",
  "main.bsky.dev",
  "deer.social",
  "ouranos.app",
  "graysky.app",
  "tokimeki.blue",
];

/** Search engines on a single fixed hostname (or a fixed suffix). */
const SEARCH_HOSTS: readonly string[] = [
  "bing.com",
  "duckduckgo.com",
  "brave.com",
  "ecosia.org",
  "startpage.com",
  "kagi.com",
  "baidu.com",
  "marginalia.nu",
  "mojeek.com",
  "qwant.com",
];

/**
 * Search engines that answer on a country-code domain per market
 * (`google.co.uk`, `yandex.com.tr`) and often from a subdomain
 * (`news.google.com`). Anchored at a dot boundary on the left and at the end of
 * the string on the right, with the public suffix bounded to the one-or-two
 * short labels real ccTLDs use — so `google.android.gm` is not a search engine.
 */
const CCTLD_SEARCH_RE =
  /(?:^|\.)(?:google|yandex)\.[a-z]{2,4}(?:\.[a-z]{2,3})?$/;

/**
 * Domain shapes we are willing to reason about: hostname characters only. A
 * value carrying a scheme, a path, or a port (`android-app://com.google…`) is
 * something PostHog recorded that isn't a referring host — it goes to "Other
 * sites" rather than being coerced into a bucket.
 */
const HOSTNAME_RE = /^[a-z0-9.-]+$/;

/** Lowercase, drop a trailing root dot, drop a leading `www.` — the three
 * cosmetic differences that would otherwise split one source into several. */
export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let domain = value.trim().toLowerCase();
  if (domain === "") return null;
  while (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (domain.startsWith("www.")) domain = domain.slice(4);
  return domain === "" ? null : domain;
}

/** `domain` is `host` or a subdomain of it. Never a substring test. */
function matchesHost(domain: string, host: string): boolean {
  return domain === host || domain.endsWith(`.${host}`);
}

function matchesAny(domain: string, hosts: readonly string[]): boolean {
  return hosts.some((host) => matchesHost(domain, host));
}

/**
 * The bucket one referring domain belongs to. Rules are applied in a fixed
 * order and the first match wins: absent → internal → Bluesky → search →
 * everything else.
 */
export function bucketForReferrer(value: unknown): SourceBucket {
  const domain = normalizeDomain(value);
  if (domain === null || domain === DIRECT_SENTINEL) return "direct";
  if (!HOSTNAME_RE.test(domain)) return "other";
  if (matchesAny(domain, INTERNAL_HOSTS)) return "internal";
  if (matchesAny(domain, BLUESKY_HOSTS)) return "bluesky";
  if (matchesAny(domain, SEARCH_HOSTS) || CCTLD_SEARCH_RE.test(domain))
    return "search";
  return "other";
}

/** How many actual domains the "Other sites" disclosure lists. */
export const MAX_OTHER_DOMAINS = 5;

export type ReferrerRow = { domain: string; views: number };

export type BucketedSources = {
  /** Non-zero buckets only, most views first. A bucket with no views is
   * omitted rather than drawn as an empty row. */
  buckets: Array<{ bucket: SourceBucket; views: number }>;
  /** The named domains behind "Other sites" — the genuinely interesting part. */
  topOtherDomains: ReferrerRow[];
  /** What the percentages are taken against. */
  total: number;
};

/**
 * Buckets a page of referring domains and RECONCILES THE TAIL against the
 * authoritative range total.
 *
 * The referrer query returns a bounded top-N of domains, so the domains past
 * the cut are real views with no row. Their count is the difference between the
 * total we know and the total we bucketed, and it is added to "Other sites" —
 * which is exactly what it is. Without this the percentages silently fail to
 * reach 100 and the surface understates every writer's traffic.
 */
export function bucketReferrers(
  rows: Iterable<{ domain: unknown; views: unknown }>,
  total: number,
): BucketedSources {
  const counts = new Map<SourceBucket, number>();
  const otherDomains: ReferrerRow[] = [];
  let bucketed = 0;

  for (const row of rows) {
    const views = row.views;
    if (typeof views !== "number" || !Number.isFinite(views) || views < 0)
      continue;
    const bucket = bucketForReferrer(row.domain);
    counts.set(bucket, (counts.get(bucket) ?? 0) + views);
    bucketed += views;
    const domain = normalizeDomain(row.domain);
    if (bucket === "other" && domain !== null)
      otherDomains.push({ domain, views });
  }

  // The unbucketed remainder is "other sites we didn't get a row for" — never a
  // negative, in case the totals come from queries that disagree at the edge.
  const safeTotal = Number.isFinite(total) && total > 0 ? total : bucketed;
  const tail = Math.max(0, safeTotal - bucketed);
  if (tail > 0) counts.set("other", (counts.get("other") ?? 0) + tail);

  const buckets = [...counts.entries()]
    .filter(([, views]) => views > 0)
    .map(([bucket, views]) => ({ bucket, views }))
    .sort(
      (a, b) =>
        b.views - a.views ||
        BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket),
    );

  return {
    buckets,
    topOtherDomains: otherDomains
      .sort((a, b) => b.views - a.views || a.domain.localeCompare(b.domain))
      .slice(0, MAX_OTHER_DOMAINS),
    total: safeTotal,
  };
}
