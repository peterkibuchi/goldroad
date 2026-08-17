import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PublishedRow } from "../routes/dashboard";

/**
 * A published row has three things it can say about its announcement, and they
 * are three different claims:
 *
 * - never announced → offer to announce;
 * - announced and still there → link to it;
 * - announced and GONE → say so, and don't hand the writer a dead link.
 *
 * The third was missing. The dashboard read its counts through a path that
 * folded "the AppView doesn't have this post" into the same silence as "we
 * couldn't reach the AppView", so a writer who deleted an announcement on
 * Bluesky kept being offered "Announced ↗" to a 404 indefinitely, with nothing
 * on the row hinting why. These cases pin all three.
 */
afterEach(cleanup);

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

/** The row shape PublishedRow consumes, at its three announcement states. */
function row(
  extra: Partial<Parameters<typeof PublishedRow>[0]["row"]> = {},
): Parameters<typeof PublishedRow>[0]["row"] {
  return {
    rkey: "3lyk73wxnok2f",
    title: "The long way round",
    description: null,
    publishedAt: "2026-02-01T10:00:00.000Z",
    updatedAt: null,
    coverPath: null,
    readingMinutes: 4,
    editable: true,
    announced: { did: DID, postRkey: "3lyannounce01" },
    engagement: null,
    announceGone: false,
    ...extra,
  };
}

const renderRow = (extra: Parameters<typeof row>[0] = {}) =>
  render(<PublishedRow ident="writer.example" row={row(extra)} />);

describe("PublishedRow — an announcement that is still on Bluesky", () => {
  it("links to it", () => {
    renderRow();
    const link = screen.getByRole("link", { name: /Announced/ });
    expect(link.getAttribute("href")).toBe(
      `https://bsky.app/profile/${DID}/post/3lyannounce01`,
    );
  });
});

describe("PublishedRow — an announcement that is gone from Bluesky", () => {
  it("says so instead of linking to a post that isn't there", () => {
    renderRow({ announceGone: true });
    expect(screen.getByText(/Announcement gone from Bluesky/)).toBeDefined();
    // The dead link is GONE, not merely restyled.
    expect(screen.queryByRole("link", { name: /Announced/ })).toBeNull();
    expect(
      screen
        .queryAllByRole("link")
        .some((a) => a.getAttribute("href")?.includes("bsky.app/profile")),
    ).toBe(false);
  });

  it("still offers to announce again, and says the earlier one is gone", () => {
    renderRow({ announceGone: true });
    const button = screen.getByRole("button", { name: "Announce again" });
    expect(button).toBeDefined();
    // The confirm copy has to say a NEW post is being made, not that the old
    // one is being repaired — the writer is about to post to their followers.
    expect(button.closest("form")?.textContent).toBeDefined();
  });

  it("does not present gone-ness as an engagement count", () => {
    renderRow({ announceGone: true });
    // No zeroes: absence-is-not-zero holds here as everywhere else.
    expect(document.body.textContent).not.toMatch(
      /\b0 (likes|views|replies)\b/,
    );
  });
});

describe("PublishedRow — never announced", () => {
  it("offers a plain announce, with no claim about a past one", () => {
    renderRow({ announced: null });
    expect(screen.getByRole("button", { name: "Announce" })).toBeDefined();
    expect(document.body.textContent).not.toMatch(
      /gone from Bluesky|Announced/,
    );
  });

  it("cannot be gone if it was never announced", () => {
    // announceGone only ever accompanies an announced row (it comes from a
    // lookup keyed off the ref), but the row must not invent a claim if it does.
    renderRow({ announced: null, announceGone: true });
    expect(document.body.textContent).not.toMatch(/gone from Bluesky/);
  });
});
