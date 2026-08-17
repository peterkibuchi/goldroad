import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The /import/threads surface: the picker's honesty (the drafts budget, the
 * feed window, already-imported threads), the two-line row a thread needs, the
 * empty state that teaches the rule, and the progress rows including the
 * partial failures. import_.threads.tsx is a route file: the
 * `cloudflare:workers` alias in vitest.config.ts stubs its bindings.
 */
import {
  FindingState,
  isAssembledBody,
  isDiscoveryBody,
  ThreadPicker,
  ThreadProgress,
  type WireThread,
} from "../routes/import_.threads";

afterEach(cleanup);

const DID = "did:plc:fake2222222222writer2222";

function thread(overrides: Partial<WireThread> = {}): WireThread {
  const rkey = overrides.rootUri?.split("/").at(-1) ?? "3aa1";
  return {
    alreadyImported: false,
    createdAt: "2026-02-04T10:00:00.000Z",
    guidHash: `hash-${rkey}`,
    postCount: 12,
    rootUri: `at://${DID}/app.bsky.feed.post/${rkey}`,
    title: "On leaving",
    url: `https://bsky.app/profile/${DID}/post/${rkey}`,
    ...overrides,
  };
}

function renderPicker(
  data: Partial<React.ComponentProps<typeof ThreadPicker>["data"]> = {},
  selected: string[] = ["hash-3aa1"],
) {
  const onToggle = vi.fn();
  const onToggleAll = vi.fn();
  const onImport = vi.fn();
  render(
    <ThreadPicker
      data={{
        draftSlotsRemaining: 47,
        threads: [thread()],
        truncated: false,
        ...data,
      }}
      onImport={onImport}
      onToggle={onToggle}
      onToggleAll={onToggleAll}
      selected={new Set(selected)}
    />,
  );
  return { onImport, onToggle, onToggleAll };
}

describe("ThreadPicker — the row says what a thread is", () => {
  it("shows the first line, the post count and the date", () => {
    renderPicker();
    expect(screen.getByText("On leaving")).toBeDefined();
    // The count is the reason a writer is here — it has to be on the row.
    expect(screen.getByText("12 posts")).toBeDefined();
    expect(screen.getByRole("checkbox")).toBeDefined();
    expect(
      document.querySelector('time[datetime="2026-02-04T10:00:00.000Z"]'),
    ).not.toBeNull();
  });

  it("singularizes a two-post thread's count", () => {
    renderPicker({ threads: [thread({ postCount: 1 })] });
    expect(screen.getByText("1 post")).toBeDefined();
  });

  it("badges an already-imported thread and disables its checkbox", () => {
    renderPicker({ threads: [thread({ alreadyImported: true })] }, []);
    expect(screen.getByText(/already imported/i)).toBeDefined();
    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  });

  it("counts the selection into the button, and refuses an empty run", () => {
    renderPicker({}, []);
    const button = screen.getByRole("button", { name: /import 0 to drafts/i });
    expect(button).toHaveProperty("disabled", true);
  });

  it("toggles one thread by its ledger key", () => {
    const { onToggle } = renderPicker();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("hash-3aa1");
  });
});

describe("ThreadPicker — honesty", () => {
  it("says the feed is a window when the AppView had more", () => {
    renderPicker({ truncated: true });
    expect(screen.getByText(/recent window of your posts/i)).toBeDefined();
    expect(screen.getByText(/older threads than these/i)).toBeDefined();
  });

  it("says it found everything when the walk finished", () => {
    renderPicker({ truncated: false });
    expect(
      screen.getByText(/that's every thread in the window/i),
    ).toBeDefined();
  });

  it("warns when the selection is past the drafts headroom", () => {
    renderPicker(
      {
        draftSlotsRemaining: 1,
        threads: [
          thread(),
          thread({ rootUri: `at://${DID}/app.bsky.feed.post/3aa2` }),
        ],
      },
      ["hash-3aa1", "hash-3aa2"],
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /room for 1 draft — importing 2 will stop at the limit/i,
    );
  });

  it("states the provenance stance before the import, not after", () => {
    renderPicker();
    // The load-bearing difference from a feed import: these pages stay the
    // original. A writer needs that BEFORE they decide.
    expect(screen.getByText(/these pages stay the original/i)).toBeDefined();
    expect(screen.getByText(/line pointing back at the thread/i)).toBeDefined();
  });

  it("names what cannot come across", () => {
    renderPicker();
    expect(
      screen.getByText(/quotes of other people's posts come across as a link/i),
    ).toBeDefined();
    expect(screen.getByText(/the video doesn't/i)).toBeDefined();
  });

  it("offers the select-all only when there is more than one to select", () => {
    renderPicker({}, []);
    expect(screen.queryByRole("button", { name: /select all/i })).toBeNull();

    cleanup();
    const { onToggleAll } = renderPicker(
      {
        threads: [
          thread(),
          thread({ rootUri: `at://${DID}/app.bsky.feed.post/3aa2` }),
        ],
      },
      [],
    );
    fireEvent.click(
      screen.getByRole("button", { name: /select all that fit/i }),
    );
    expect(onToggleAll).toHaveBeenCalled();
  });
});

describe("ThreadPicker — the empty state teaches the rule", () => {
  it("explains what a thread is instead of looking broken", () => {
    renderPicker({ threads: [] }, []);
    expect(
      screen.getByRole("heading", { name: /no threads found/i }),
    ).toBeDefined();
    expect(screen.getByText(/at least one of your own replies/i)).toBeDefined();
    // And why a daily poster might still see nothing.
    expect(
      screen.getByText(/single posts, and replies to other people/i),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: /write something new/i }),
    ).toBeDefined();
    // No dead primary: the import button isn't offered with nothing to import.
    expect(screen.queryByRole("button", { name: /import/i })).toBeNull();
  });
});

describe("FindingState", () => {
  it("shows skeletons, never a spinner", () => {
    render(<FindingState error={null} onRetry={() => {}} />);
    expect(screen.getByRole("status")).toBeDefined();
    const pulses = document.querySelectorAll(".animate-pulse");
    expect(pulses.length).toBeGreaterThan(0);
    // Reduced motion is a baseline, not an option.
    for (const pulse of pulses)
      expect(pulse.className).toContain("motion-reduce:animate-none");
  });

  it("names the upstream, not the writer, when Bluesky flakes", () => {
    const onRetry = vi.fn();
    render(<FindingState error="appview_failed" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /that's on their side, not yours/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("reassures about drafts when the hourly limit is hit", () => {
    render(<FindingState error="rate_limited" onRetry={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /your drafts are unaffected/i,
    );
  });
});

describe("ThreadProgress — partial failure is a row, not a dead end", () => {
  const data = {
    draftSlotsRemaining: 47,
    threads: [
      thread({ title: "Saved one" }),
      thread({
        rootUri: `at://${DID}/app.bsky.feed.post/3aa2`,
        title: "Failed one",
      }),
      thread({
        rootUri: `at://${DID}/app.bsky.feed.post/3aa3`,
        title: "Skipped one",
      }),
    ],
    truncated: false,
  };
  const selected = new Set(["hash-3aa1", "hash-3aa2", "hash-3aa3"]);

  it("reports each row's own outcome and a truthful total", () => {
    render(
      <ThreadProgress
        data={data}
        done={true}
        selected={selected}
        status={{
          "hash-3aa1": { kind: "saved" },
          "hash-3aa2": {
            kind: "failed",
            reason: "no longer a thread on Bluesky",
          },
          "hash-3aa3": { kind: "skipped", reason: "already in your drafts" },
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /imported 1 of 3/i }),
    ).toBeDefined();
    expect(screen.getByText("Saved to drafts")).toBeDefined();
    expect(
      screen.getByText(/couldn't import — no longer a thread on bluesky/i),
    ).toBeDefined();
    expect(screen.getByText(/skipped — already in your drafts/i)).toBeDefined();
    expect(screen.getByText(/1 draft saved, 2 skipped/i)).toBeDefined();
    // Nothing changed at the source, and nothing published.
    expect(
      screen.getByText(/your threads on bluesky haven't changed/i),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: /review your drafts/i }),
    ).toBeDefined();
  });

  it("announces progress politely while it runs, and offers no finish link yet", () => {
    render(
      <ThreadProgress
        data={data}
        done={false}
        selected={selected}
        status={{ "hash-3aa1": { kind: "reading" } }}
      />,
    );
    expect(document.querySelector('ul[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByLabelText("Reading thread")).toBeDefined();
    expect(
      screen.queryByRole("link", { name: /review your drafts/i }),
    ).toBeNull();
  });
});

describe("response-shape guards", () => {
  const good = {
    ok: true,
    draftSlotsRemaining: 47,
    truncated: false,
    threads: [thread()],
  };

  it("accepts our own discovery body", () => {
    expect(isDiscoveryBody(good)).toBe(true);
  });

  it("refuses a refusal, a drifted shape, and a captive-portal answer", () => {
    expect(isDiscoveryBody({ ok: false, error: "rate_limited" })).toBe(false);
    expect(isDiscoveryBody({ ...good, threads: [{ title: "x" }] })).toBe(false);
    expect(isDiscoveryBody({ ...good, draftSlotsRemaining: "lots" })).toBe(
      false,
    );
    expect(isDiscoveryBody("<html>captive portal</html>")).toBe(false);
    expect(isDiscoveryBody(null)).toBe(false);
  });

  it("refuses an assembled thread with no words in it", () => {
    const base = {
      createdAt: "2026-02-04T10:00:00.000Z",
      postCount: 2,
      sourceUrl: `https://bsky.app/profile/${DID}/post/3aa1`,
      title: "On leaving",
    };
    expect(
      isAssembledBody({ ok: true, thread: { ...base, markdown: "words" } }),
    ).toBe(true);
    // An empty body would land a blank draft and read as a successful import.
    expect(
      isAssembledBody({ ok: true, thread: { ...base, markdown: "   " } }),
    ).toBe(false);
    expect(isAssembledBody({ ok: true })).toBe(false);
    expect(isAssembledBody({ ok: false, error: "not_a_thread" })).toBe(false);
  });
});
