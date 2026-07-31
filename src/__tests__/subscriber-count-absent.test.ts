import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * There is no subscriber count, and there is no zero standing in for one.
 *
 * "Every repo holding a subscription that points at this publication" is a
 * reverse lookup the protocol does not offer (see ~/lib/subscription) — it needs
 * a firehose indexer, which on the free tier is a connection we cannot hold. So
 * the number does not exist, and this file is the guard that nobody later
 * invents it: a rendered "0" would tell a writer nobody subscribed, which is a
 * claim we have no way to make. The same rule the stats page already follows for
 * uncounted views.
 *
 * The stats page's own component tree lives inside a TanStack file route and
 * needs a live router context to render, so its copy is checked in the source —
 * the same approach the archive page's closing line is checked with.
 */

const SRC = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("no subscriber count exists to render", () => {
  it("no source file computes or carries one", () => {
    // Identifiers, not prose: the honest "Subscriber totals aren't available
    // yet" line below must keep passing.
    const invented = /subscriber(s)?[_-]?(count|total)|count(ing)?Subscribers/i;
    const offenders = sourceFiles(SRC).filter((path) =>
      invented.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no surface renders a number in front of the word", () => {
    // Catches both a literal ("0 subscribers") and an interpolated one
    // ("{total} subscribers") — the second is how a zero would actually arrive,
    // as an absent number rendered by a component that assumed it had one.
    const rendered = /(\{[^{}]{1,40}\}|\b\d+)\s*&?\s*subscribers?\b/i;
    const offenders = sourceFiles(SRC).filter((path) =>
      rendered.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the writer's stats page says plainly that totals aren't available", () => {
    const source = readFileSync(join(SRC, "routes", "stats.tsx"), "utf8");
    expect(source).toContain("Subscriber totals aren't available yet");
    // Why, and the part that makes waiting worth it: the records accumulate
    // from day one and a later index backfills them.
    expect(source).toContain("being kept from today");
  });

  it("the state endpoint has no count to hand the page", () => {
    const source = readFileSync(
      join(SRC, "routes", "api.subscription.ts"),
      "utf8",
    );
    // The one thing it deliberately does not answer.
    expect(source).not.toMatch(/\bcount\b\s*[:=]/);
  });
});
