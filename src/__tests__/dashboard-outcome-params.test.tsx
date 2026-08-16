import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DashboardOutcome,
  useOutcomeParams,
  withoutOutcomeParams,
} from "../routes/dashboard";

/**
 * A published post must be counted once, no matter how many times its
 * confirmation page is looked at.
 *
 * The server redirects to /dashboard with the result in the query string —
 * `?published=<rkey>`, `?announced=<rkey>`, `?scheduled=1`. That address is
 * ordinary and reloadable, so anything that re-reads it (a refresh, the Back
 * button, a remount) re-reads the outcome too. Analytics is cookieless with
 * memory persistence: there is no downstream dedupe to save us, so
 * `post_published` ends up counting page loads instead of posts — and those
 * events are how feature adoption gets judged.
 *
 * So the params are consumed: read once, then stripped from the URL. These
 * tests hold a URL of their own and drive the hook the page drives, which is
 * the only way to see the second read that never happens.
 */

const capture = vi.hoisted(() => vi.fn());
vi.mock("../lib/posthog", () => ({ capture }));

const IDENT = "writer.example";
const RKEY = "3aaa2aaa2aaa2";
const OTHER_RKEY = "3bbb2bbb2bbb2";

beforeEach(() => {
  capture.mockClear();
});

afterEach(cleanup);

type Search = DashboardOutcome & {
  tab?: string;
  cursor?: string;
  error?: string;
  unscheduled?: boolean;
};

/**
 * Stands in for the router: owns the search params, rewrites them when the
 * hook asks, and can navigate to another address on demand.
 *
 * `strip` is swappable so a test can show what leaving the param in the URL
 * would cost — that variant is the behaviour this replaced.
 */
function Harness({
  initialSearch,
  onSearchChange,
  strip = true,
  navigateTo,
}: {
  initialSearch: Search;
  onSearchChange?: (search: Search) => void;
  strip?: boolean;
  navigateTo?: Search;
}) {
  const [search, setSearch] = useState<Search>(initialSearch);
  const stripParams = useCallback(() => {
    if (!strip) return;
    setSearch((prev) => {
      const next = withoutOutcomeParams(prev);
      onSearchChange?.(next);
      return next;
    });
  }, [strip, onSearchChange]);
  const outcome = useOutcomeParams(search, IDENT, stripParams);

  return (
    <>
      <output data-testid="url">{JSON.stringify(search)}</output>
      <output data-testid="outcome">{JSON.stringify(outcome)}</output>
      {navigateTo && (
        <button onClick={() => setSearch(navigateTo)} type="button">
          navigate
        </button>
      )}
    </>
  );
}

function url() {
  return JSON.parse(screen.getByTestId("url").textContent ?? "{}") as Search;
}

function outcome() {
  return JSON.parse(
    screen.getByTestId("outcome").textContent ?? "{}",
  ) as DashboardOutcome;
}

describe("consuming the outcome params", () => {
  it("captures the publish once and takes the param out of the URL", () => {
    render(<Harness initialSearch={{ published: RKEY, tab: "published" }} />);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("post_published", {
      rkey: RKEY,
      ident: IDENT,
    });
    // Gone from the URL; the tab — real state a writer can reload into — stays.
    expect(url().published).toBeUndefined();
    expect(url().tab).toBe("published");
  });

  it("keeps the confirmation on screen after the strip", () => {
    render(<Harness initialSearch={{ published: RKEY }} />);

    // The notice renders from this, not from the query string, so stripping
    // the param does not also take away the writer's "Published." line.
    expect(outcome().published).toBe(RKEY);
  });

  it("strips the announce and schedule params too", () => {
    const { unmount } = render(<Harness initialSearch={{ announced: RKEY }} />);
    expect(capture).toHaveBeenCalledWith("post_announced", {
      rkey: RKEY,
      ident: IDENT,
    });
    expect(url().announced).toBeUndefined();
    unmount();

    capture.mockClear();
    render(<Harness initialSearch={{ scheduled: true, cursor: "abc" }} />);
    expect(capture).toHaveBeenCalledWith("post_scheduled", { ident: IDENT });
    expect(url().scheduled).toBeUndefined();
    expect(url().cursor).toBe("abc");
  });

  it("does not capture again when the page remounts on the stripped URL", () => {
    let stripped: Search | undefined;
    const { unmount } = render(
      <Harness
        initialSearch={{ published: RKEY, tab: "published" }}
        onSearchChange={(next) => {
          stripped = next;
        }}
      />,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(stripped).toEqual({ tab: "published" });
    unmount();

    // A refresh, or Back into the dashboard: same address, new component
    // instance, so nothing in memory guards this — only the URL does.
    capture.mockClear();
    render(<Harness initialSearch={stripped ?? {}} />);
    expect(capture).not.toHaveBeenCalled();
  });

  it("would fire on every remount if the param stayed in the URL", () => {
    // The counter-case, pinning what the strip is for: with the rewrite
    // disabled the address still carries ?published=, and the next mount reads
    // it as a fresh publish.
    const { unmount } = render(
      <Harness initialSearch={{ published: RKEY }} strip={false} />,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(url().published).toBe(RKEY);
    unmount();

    render(<Harness initialSearch={{ published: RKEY }} strip={false} />);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("captures once under double-invoked effects", () => {
    render(
      <StrictMode>
        <Harness initialSearch={{ published: RKEY }} />
      </StrictMode>,
    );

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("still captures a second publish that arrives without a remount", () => {
    render(
      <Harness
        initialSearch={{ published: RKEY }}
        navigateTo={{ published: OTHER_RKEY }}
      />,
    );
    expect(capture).toHaveBeenCalledTimes(1);

    // Publishing again while the dashboard is already open is a new outcome,
    // not a replay of the old one.
    capture.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "navigate" }));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("post_published", {
      rkey: OTHER_RKEY,
      ident: IDENT,
    });
    expect(outcome().published).toBe(OTHER_RKEY);
    expect(url().published).toBeUndefined();
  });
});

describe("withoutOutcomeParams", () => {
  it("removes only the three one-shot params", () => {
    expect(
      withoutOutcomeParams({
        published: RKEY,
        announced: RKEY,
        scheduled: true,
        tab: "drafts",
        cursor: "abc",
        error: "boom",
        unscheduled: true,
      }),
    ).toEqual({
      tab: "drafts",
      cursor: "abc",
      error: "boom",
      unscheduled: true,
    });
  });

  it("is a no-op on a URL that carries none of them", () => {
    expect(withoutOutcomeParams({ tab: "drafts" })).toEqual({ tab: "drafts" });
  });
});
