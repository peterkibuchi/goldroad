import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PostsTab, ScheduledPostRow } from "../lib/dashboard";
import { PostsManager, ScheduledListRow } from "../routes/dashboard";
import { VIEWS_OFF } from "./support/views-envelope";

/**
 * The Scheduled tab exists to answer one question a writer must never have to
 * guess at: DID IT GO OUT?
 *
 * So this suite is mostly about honesty. A queued post shows its time with a
 * zone on it. A failed post shows the cron's own sentence, verbatim, plus the
 * two ways out. And an unreadable list says it couldn't be read rather than
 * rendering as "nothing is scheduled" — those are opposite claims, and one of
 * them would have a writer believing a post is coming when it isn't.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubStats() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(VIEWS_OFF))),
  );
}

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";

function scheduledRow(extra: Partial<ScheduledPostRow> = {}): ScheduledPostRow {
  return {
    id: "99999999-8888-4777-8666-555555555555",
    draftId: DRAFT_ID,
    dueAt: "2027-08-04T06:00:00.000Z",
    status: "pending",
    attempts: 0,
    lastError: null,
    title: "The long way round",
    description: null,
    ...extra,
  };
}

function renderManager(
  scheduled: ScheduledPostRow[] | null,
  tab: PostsTab = "scheduled",
) {
  stubStats();
  return render(
    <PostsManager
      drafts={[]}
      engagement={new Map()}
      ident="writer.example"
      nextCursor={null}
      onTabChange={() => {}}
      rows={[]}
      scheduled={scheduled}
      tab={tab}
    />,
  );
}

describe("a queued post", () => {
  it("names its time, with a zone on it", () => {
    render(<ScheduledListRow row={scheduledRow()} />);
    const label = screen.getByText(/Scheduled for/);
    expect(label.textContent).toMatch(/Aug 4, 2027/);
    // Either render (UTC on the server, local after mount) names its zone: a
    // bare "9:00 AM" is the one label a travelling writer can misread.
    expect(label.textContent).toMatch(/UTC|GMT|[A-Z]{2,5}|[+-]\d/);
  });

  it("carries the machine-readable instant too", () => {
    render(<ScheduledListRow row={scheduledRow()} />);
    const time = document.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2027-08-04T06:00:00.000Z");
  });

  it("offers edit, publish-now and cancel — all through /api/publish", () => {
    render(<ScheduledListRow row={scheduledRow()} />);
    const forms = [...document.querySelectorAll("form")];
    expect(forms.map((f) => f.getAttribute("action"))).toEqual([
      "/api/publish",
      "/api/publish",
    ]);
    const intents = forms.map(
      (f) =>
        (f.querySelector('input[name="intent"]') as HTMLInputElement | null)
          ?.value,
    );
    expect(intents).toEqual(["publish-now", "unschedule"]);
    expect(
      screen.getByRole("link", { name: "Edit" }).getAttribute("href"),
    ).toBe(`/write?draft=${DRAFT_ID}`);
  });

  it("asks before giving up a scheduled slot", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<ScheduledListRow row={scheduledRow()} />);
    const submitted: Event[] = [];
    window.addEventListener("submit", (event) => {
      submitted.push(event);
      event.preventDefault();
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    expect(confirm).toHaveBeenCalled();
    expect(submitted[0]?.defaultPrevented).toBe(true);
  });
});

describe("a post that did NOT go out", () => {
  const failed = scheduledRow({
    status: "failed",
    attempts: 3,
    lastError:
      "Goldroad couldn't use your connection to your data server, so this post did not go out — sign in again, then publish it now.",
  });

  it("shows the cron's own reason, verbatim", () => {
    render(<ScheduledListRow row={failed} />);
    const alert = screen.getByRole("alert");
    // Verbatim, not paraphrased: a second copy of this sentence in the UI would
    // be free to drift from the one in the database.
    expect(alert.textContent).toBe(failed.lastError);
  });

  it("says so in the row's own line, not only in the notice", () => {
    render(<ScheduledListRow row={failed} />);
    expect(screen.getByText(/Didn't go out/)).toBeTruthy();
  });

  it("offers publish-now WITHOUT a confirmation — publishing is the fix", () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<ScheduledListRow row={failed} />);
    window.addEventListener("submit", (event) => event.preventDefault());
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not leave a reason-less failure mute", () => {
    render(<ScheduledListRow row={{ ...failed, lastError: null }} />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /didn't go out.*didn't record why/i,
    );
  });

  it("says how many attempts were spent", () => {
    render(<ScheduledListRow row={failed} />);
    expect(screen.getByText("3 attempts")).toBeTruthy();
  });
});

describe("the tab and its empty states", () => {
  it("lists the queue and counts what is waiting", () => {
    renderManager([
      scheduledRow(),
      scheduledRow({ id: "row-2", title: "Second piece" }),
    ]);
    expect(screen.getByText(/2 posts waiting/)).toBeTruthy();
    expect(screen.getByText("The long way round")).toBeTruthy();
    expect(screen.getByText("Second piece")).toBeTruthy();
  });

  it("counts failures in the section rule, where the eye already is", () => {
    renderManager([
      scheduledRow(),
      scheduledRow({ id: "row-2", status: "failed", lastError: "Nope." }),
    ]);
    expect(screen.getByText(/1 didn't go out/)).toBeTruthy();
  });

  it("distinguishes 'nothing scheduled' from 'we couldn't read your queue'", () => {
    const { unmount } = renderManager([]);
    expect(screen.getByText(/Nothing scheduled/)).toBeTruthy();
    unmount();
    cleanup();

    renderManager(null);
    // Opposite claims: one of them would have a writer believing a post is
    // still coming when we simply don't know.
    expect(screen.queryByText(/Nothing scheduled/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /couldn't be loaded.*still queued/is,
    );
  });

  it("shows no tab at all when there is nothing queued and it isn't selected", () => {
    renderManager([], "published");
    expect(screen.queryByRole("tab", { name: /scheduled/i })).toBeNull();
  });

  it("keeps the tab while it IS the selected one, empty queue or not", () => {
    // `tab=scheduled` is validated URL state, and cancelling the last schedule
    // redirects straight to it. A selected tab with no button leaves the panel's
    // aria-labelledby pointing at nothing and no visible mark of where you are.
    renderManager([]);
    const tab = screen.getByRole("tab", { name: /scheduled/i });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("tab-scheduled")).not.toBeNull();
  });

  it("keeps the tab when the queue couldn't be read", () => {
    renderManager(null, "published");
    expect(screen.getByRole("tab", { name: /scheduled/i })).toBeTruthy();
  });

  it("shows the tab, with its count, the moment something is queued", () => {
    renderManager([scheduledRow()]);
    const tab = screen.getByRole("tab", { name: /scheduled/i });
    expect(tab.textContent).toMatch(/1/);
  });
});
