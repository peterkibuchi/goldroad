import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard's announce affordances, after announcing became the default.
 *
 * The rule this file exists for: THE POST-PUBLISH NOTICE MUST NOT OFFER TO
 * ANNOUNCE A POST THAT HAS ALREADY BEEN ANNOUNCED. It used to, unconditionally,
 * because a publish could never have announced anything — now it can, and a
 * button whose only outcome is the server's idempotency refusal is a control
 * that does nothing. Worse, it invites a writer to press it twice: the Bluesky
 * post permission is create-only, so a duplicate card is one nobody here can
 * take down.
 *
 * The row's "Announce again" is the deliberate exception, and it is the only
 * thing in the app that sends `force=1`.
 */
import {
  AnnounceButton,
  PostsManager,
  PublishedNotice,
  ReconnectForm,
} from "../routes/dashboard";
import { VIEWS_OFF } from "./support/views-envelope";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The manager reads /api/stats on mount; none of this is about views. */
function stubStats() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(VIEWS_OFF))),
  );
}

const RKEY = "3lyk73wxnok2f";
const DID = "did:plc:fake2222222222writer2222";

function row(over: Record<string, unknown> = {}) {
  return {
    rkey: RKEY,
    title: "The long way round",
    description: null,
    publishedAt: "2026-08-17T09:00:00.000Z",
    updatedAt: null,
    editable: true,
    coverPath: null,
    readingMinutes: 4,
    announced: null as { did: string; postRkey: string } | null,
    ...over,
  };
}

function fieldsOf(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new FormData(form)) out[key] = String(value);
  return out;
}

describe("AnnounceButton — force is the exception, not the default", () => {
  it("sends no force flag for a post that has never been announced", () => {
    const { container } = render(<AnnounceButton rkey={RKEY} />);
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    const fields = fieldsOf(form);
    expect(fields.intent).toBe("announce");
    expect(fields.rkey).toBe(RKEY);
    expect(fields.force).toBeUndefined();
  });

  it("sends force=1 only alongside a confirmation", () => {
    const { container } = render(
      <AnnounceButton
        confirmMessage="Post a second one?"
        label="Announce again"
        rkey={RKEY}
      />,
    );
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    expect(fieldsOf(form).force).toBe("1");
  });
});

describe("the posts manager's row actions", () => {
  it("offers a plain Announce on a post with no announcement", () => {
    stubStats();
    render(
      <PostsManager
        drafts={[]}
        engagement={new Map()}
        ident="writer.example"
        nextCursor={null}
        onTabChange={() => {}}
        rows={[row()]}
        scheduled={[]}
        tab="published"
      />,
    );
    screen.getByRole("button", { name: "Announce" });
    expect(screen.queryByRole("button", { name: "Announce again" })).toBeNull();
  });

  it("offers Announce again — with the consequence in the confirm — once one exists", () => {
    stubStats();
    render(
      <PostsManager
        drafts={[]}
        engagement={new Map()}
        ident="writer.example"
        nextCursor={null}
        onTabChange={() => {}}
        rows={[row({ announced: { did: DID, postRkey: "3lz9999999999" } })]}
        scheduled={[]}
        tab="published"
      />,
    );
    const again = screen.getByRole("button", { name: "Announce again" });
    const form = again.closest("form");
    if (!form) throw new Error("no form");
    // The one force in the app, and it is reachable only past a confirm.
    expect(fieldsOf(form).force).toBe("1");
    // And the link to the existing post, so "again" is a real choice.
    screen.getByRole("link", { name: /Announced/ });
  });
});

describe("ReconnectForm", () => {
  it("returns the writer to the dashboard with their handle prefilled", () => {
    // Shared by the error notice and the published notice, so a scope failure
    // on the publish path does not grow a second copy of this sentence.
    const { container } = render(<ReconnectForm handle="writer.example" />);
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    expect(form.getAttribute("action")).toBe("/login");
    const fields = fieldsOf(form);
    expect(fields.handle).toBe("writer.example");
    expect(fields.returnTo).toBe("/dashboard");
    expect(form.textContent).toMatch(/approve the new permission/i);
  });
});

describe("the post-publish notice", () => {
  const notice = (over: Partial<Parameters<typeof PublishedNotice>[0]> = {}) =>
    render(
      <PublishedNotice
        announceFailed={undefined}
        announced={undefined}
        handle="writer.example"
        ident="writer.example"
        rkey={RKEY}
        {...over}
      />,
    );

  it("confirms the publish and links the live page, always", () => {
    notice();
    expect(screen.getByText(/Published\./)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /view it live/i }).getAttribute("href"),
    ).toBe(`/@writer.example/${RKEY}`);
  });

  it("offers the button when announcing was off", () => {
    notice();
    screen.getByRole("button", { name: /announce/i });
  });

  /**
   * THE RULE. A publish that announced leaves a `bskyPostRef` on the document,
   * so the server refuses a second announce — a button here would do nothing
   * except invite a writer to press it again, and the create-only scope means
   * the duplicate it eventually makes is one nobody in this app can delete.
   */
  it("offers NO button once the publish has already announced", () => {
    notice({ announced: "3lz9999999999" });
    expect(screen.queryByRole("button", { name: /announce/i })).toBeNull();
    // And no offer text either — the "Announced" notice beside this one speaks.
    expect(screen.queryByText(/post this to bluesky now/i)).toBeNull();
  });

  it("says the post is live and the card is not, and offers the fix", () => {
    notice({ announceFailed: "announce_failed" });
    // The publish is confirmed first; the failure is about the announcement.
    expect(screen.getByText(/Published\./)).toBeTruthy();
    screen.getByText(/announcing it on bluesky didn't go through/i);
    screen.getByRole("button", { name: /announce/i });
  });

  it("offers re-connect instead of a button a stale grant cannot satisfy", () => {
    notice({ announceFailed: "announce_scope" });
    // Pressing Announce would fail exactly the same way. The re-connect is the
    // only thing that changes the outcome.
    expect(screen.queryByRole("button", { name: /^announce/i })).toBeNull();
    screen.getByRole("button", { name: /re-connect your account/i });
    expect(screen.getByText(/Published\./)).toBeTruthy();
  });

  it("still says the post is live when the handle won't resolve", () => {
    // No handle means no re-connect form, and that must not take the
    // confirmation down with it.
    notice({ announceFailed: "announce_scope", handle: null });
    expect(screen.getByText(/Published\./)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /re-connect your account/i }),
    ).toBeNull();
  });
});
