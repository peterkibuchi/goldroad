import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The posts manager's tab strip, driven the way a keyboard-only writer drives
 * it. The strip implements a roving tabindex — only the selected tab is
 * tabbable — which is half of the ARIA tabs pattern; without the arrow keys
 * that half is a trap rather than a convenience, because Tab lands on the
 * selected tab and then leaves the strip entirely. The tab it stranded was
 * Scheduled, which is the one that answers "did it go out?".
 *
 * So every test here presses a key and then asserts on the three things a
 * writer actually experiences: where focus is, which tab claims to be
 * selected, and which panel's rows are on screen. Asserting the handler exists
 * would prove nothing.
 */
import type { DraftRow, PostsTab, ScheduledPostRow } from "../lib/dashboard";
import { PostsManager } from "../routes/dashboard";
import { VIEWS_OFF } from "./support/views-envelope";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The manager reads /api/stats on mount; nothing here is about views. */
function stubStats() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(VIEWS_OFF))),
  );
}

const DRAFTS: DraftRow[] = [
  {
    id: "11111111-2222-4333-8444-555555555555",
    title: "Draft about zebras",
    updatedAt: "2026-07-10T00:00:00.000Z",
    description: null,
  },
];

const SCHEDULED: ScheduledPostRow[] = [
  {
    id: "99999999-8888-4777-8666-555555555555",
    draftId: DRAFTS[0].id,
    dueAt: "2027-08-04T06:00:00.000Z",
    status: "pending",
    attempts: 0,
    lastError: null,
    title: "The long way round",
    description: null,
  },
];

/**
 * The manager takes its selected tab from the URL, so the route owns the
 * state. A keyboard test needs that whole loop — press, onTabChange, the prop
 * comes back changed — or arrow keys would appear to do nothing for reasons
 * that have nothing to do with the handler under test.
 */
function ControlledManager({
  scheduled,
  initial = "published",
}: {
  scheduled: ScheduledPostRow[] | null;
  initial?: PostsTab;
}) {
  const [tab, setTab] = useState<PostsTab>(initial);
  return (
    <PostsManager
      drafts={DRAFTS}
      engagement={new Map()}
      ident="writer.example"
      nextCursor={null}
      onTabChange={setTab}
      rows={[]}
      scheduled={scheduled}
      tab={tab}
    />
  );
}

/** Renders the strip and puts focus where Tab would leave it: the selected
 * tab, the only tabbable one. */
function renderStrip(
  props: React.ComponentProps<typeof ControlledManager>,
): void {
  stubStats();
  render(<ControlledManager {...props} />);
  const selected = screen.getByRole("tab", { selected: true });
  selected.focus();
  expect(document.activeElement).toBe(selected);
}

/** Presses a key on whatever has focus, and reports whether the strip claimed
 * it (fireEvent returns false when the handler called preventDefault). */
function press(key: string): { claimed: boolean } {
  const target = document.activeElement ?? document.body;
  return { claimed: !fireEvent.keyDown(target, { key }) };
}

/**
 * The whole point, in one assertion: this tab is focused, it says it is
 * selected, it is the tabbable one, and its panel is the visible one. Returns
 * that panel so a caller can go on to check what is actually inside it.
 */
function expectArrivedAt(name: RegExp): HTMLElement {
  const tab = screen.getByRole("tab", { name });
  expect(document.activeElement).toBe(tab);
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(tab.tabIndex).toBe(0);
  const panelId = tab.getAttribute("aria-controls") ?? "";
  const panel = document.getElementById(panelId);
  if (!panel) throw new Error(`no panel for ${panelId}`);
  // The other panels stay in the DOM, so "visible" is the hidden attribute —
  // which is also what keeps their rows out of the writer's way.
  expect(panel.hasAttribute("hidden")).toBe(false);
  return panel;
}

describe("the tab strip, by keyboard alone", () => {
  it("walks right through every tab and wraps to the first", () => {
    renderStrip({ scheduled: SCHEDULED });

    expect(press("ArrowRight").claimed).toBe(true);
    // The tab a writer could not reach before: its queue is now on screen.
    within(expectArrivedAt(/scheduled/i)).getByText("The long way round");

    press("ArrowRight");
    within(expectArrivedAt(/drafts/i)).getByText("Draft about zebras");

    // Wrap: a dead end at the edge is how a keyboard user concludes the rest
    // of the strip doesn't exist.
    press("ArrowRight");
    expectArrivedAt(/published/i);
  });

  it("walks left through every tab and wraps to the last", () => {
    renderStrip({ scheduled: SCHEDULED });

    press("ArrowLeft");
    expectArrivedAt(/drafts/i);

    press("ArrowLeft");
    within(expectArrivedAt(/scheduled/i)).getByText("The long way round");

    press("ArrowLeft");
    expectArrivedAt(/published/i);
  });

  it("jumps to the ends with Home and End", () => {
    renderStrip({ scheduled: SCHEDULED, initial: "scheduled" });

    expect(press("End").claimed).toBe(true);
    expectArrivedAt(/drafts/i);

    expect(press("Home").claimed).toBe(true);
    expectArrivedAt(/published/i);

    // Home on the first tab is a no-op that still leaves focus somewhere sane.
    press("Home");
    expectArrivedAt(/published/i);
  });

  it("walks the two-tab strip when nothing is queued", () => {
    renderStrip({ scheduled: [] });
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // Right from Published reaches Drafts directly: the keys walk what is on
    // screen, never a tab that isn't rendered.
    press("ArrowRight");
    expectArrivedAt(/drafts/i);
    expect(screen.queryByRole("tab", { name: /scheduled/i })).toBeNull();

    press("ArrowRight");
    expectArrivedAt(/published/i);
    press("End");
    expectArrivedAt(/drafts/i);
  });

  it("reaches the queue when the scheduled list couldn't be read", () => {
    // null is "we couldn't read it", not "nothing is queued" — the tab is
    // there, and so it has to be reachable.
    renderStrip({ scheduled: null });
    press("ArrowRight");
    expectArrivedAt(/scheduled/i);
  });

  it("leaves keys it doesn't own to the browser", () => {
    renderStrip({ scheduled: SCHEDULED });
    for (const key of ["Tab", "ArrowDown", "a", "Enter"]) {
      expect(press(key).claimed).toBe(false);
    }
    // And nothing moved.
    expectArrivedAt(/published/i);
  });
});
