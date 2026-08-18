import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SettingsOutcome,
  useSettingsOutcome,
  withoutSettingsOutcomeParams,
} from "../routes/settings";

/**
 * A setting changed once must be counted once.
 *
 * /settings has the same shape the dashboard already fixed: the forms post to
 * /api/publish, which redirects back here with the result in the query string
 * (`?saved=1&kind=announcing`, `?moved=1`). That address is ordinary and
 * reloadable, so a refresh, a Back, or a remount re-reads the outcome — and
 * analytics is cookieless with memory persistence, so there is no downstream
 * dedupe to absorb the repeat.
 *
 * It matters more here than it did there. `announce_default_changed` is the one
 * event that says how many writers turn a DEFAULT-ON feature off; if reloads
 * inflate it, the number that decides whether the default was right is the
 * number that cannot be trusted. `theme_saved` had the identical defect on the
 * neighbouring line and is fixed in the same pass.
 */

const capture = vi.hoisted(() => vi.fn());
vi.mock("../lib/posthog", () => ({ capture }));

const IDENT = "writer.example";

beforeEach(() => {
  capture.mockClear();
});

afterEach(cleanup);

type Search = SettingsOutcome & { error?: string };

/**
 * Stands in for the router: owns the search params and rewrites them when the
 * hook asks. `strip` is swappable so a test can show what leaving the params in
 * the URL would cost — that variant is the behaviour this replaced.
 */
function Harness({
  initialSearch,
  announceDefault = false,
  onSearchChange,
  strip = true,
  navigateTo,
}: {
  initialSearch: Search;
  announceDefault?: boolean;
  onSearchChange?: (search: Search) => void;
  strip?: boolean;
  navigateTo?: Search;
}) {
  const [search, setSearch] = useState<Search>(initialSearch);
  const stripParams = useCallback(() => {
    if (!strip) return;
    setSearch((prev) => {
      const next = withoutSettingsOutcomeParams(prev);
      onSearchChange?.(next);
      return next;
    });
  }, [strip, onSearchChange]);
  const outcome = useSettingsOutcome(
    search,
    IDENT,
    announceDefault,
    stripParams,
  );

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
  ) as SettingsOutcome;
}

describe("consuming the settings outcome params", () => {
  it("captures the announcing change once and takes the params out of the URL", () => {
    render(
      <Harness
        announceDefault={false}
        initialSearch={{ saved: true, kind: "announcing" }}
      />,
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("announce_default_changed", {
      ident: IDENT,
      enabled: false,
    });
    expect(url().saved).toBeUndefined();
    expect(url().kind).toBeUndefined();
  });

  it("keeps the confirmation on screen after the strip", () => {
    render(<Harness initialSearch={{ saved: true, kind: "theme" }} />);
    // The notice renders from this, not from the query string, so stripping
    // does not also take away the writer's "Saved." line.
    expect(outcome().saved).toBe(true);
    expect(outcome().kind).toBe("theme");
  });

  it("captures the theme save once, on the same path", () => {
    render(<Harness initialSearch={{ saved: true, kind: "theme" }} />);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("theme_saved", { ident: IDENT });
  });

  it("does not capture again when the page remounts on the stripped URL", () => {
    let stripped: Search | undefined;
    const { unmount } = render(
      <Harness
        initialSearch={{ saved: true, kind: "announcing", error: "boom" }}
        onSearchChange={(next) => {
          stripped = next;
        }}
      />,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    // `error` is durable state a writer can reload into; only the one-shots go.
    expect(stripped).toEqual({ error: "boom" });
    unmount();

    // A refresh, or Back into settings: same address, new component instance,
    // so nothing in memory guards this — only the URL does.
    capture.mockClear();
    render(<Harness initialSearch={stripped ?? {}} />);
    expect(capture).not.toHaveBeenCalled();
  });

  it("would fire on every remount if the params stayed in the URL", () => {
    // The counter-case, pinning what the strip is for: with the rewrite
    // disabled the address still says ?saved=1&kind=announcing, and the next
    // mount reads it as a fresh decision. Two reloads, three writers.
    const { unmount } = render(
      <Harness
        initialSearch={{ saved: true, kind: "announcing" }}
        strip={false}
      />,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(url().saved).toBe(true);
    unmount();

    render(
      <Harness
        initialSearch={{ saved: true, kind: "announcing" }}
        strip={false}
      />,
    );
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("captures once under double-invoked effects", () => {
    render(
      <StrictMode>
        <Harness initialSearch={{ saved: true, kind: "announcing" }} />
      </StrictMode>,
    );
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("still captures a second save that arrives without a remount", () => {
    render(
      <Harness
        announceDefault={false}
        initialSearch={{ saved: true, kind: "theme" }}
        navigateTo={{ saved: true, kind: "announcing" }}
      />,
    );
    expect(capture).toHaveBeenCalledTimes(1);

    // Changing another setting while the page is open is a new outcome, not a
    // replay of the old one.
    capture.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "navigate" }));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("announce_default_changed", {
      ident: IDENT,
      enabled: false,
    });
    expect(url().saved).toBeUndefined();
  });

  it("reports the value the save actually wrote, not the one it replaced", () => {
    // `announceDefault` comes from the loader, i.e. from the row the save just
    // wrote — so a writer turning announcing ON is recorded as enabled: true.
    render(
      <Harness
        announceDefault
        initialSearch={{ saved: true, kind: "announcing" }}
      />,
    );
    expect(capture).toHaveBeenCalledWith("announce_default_changed", {
      ident: IDENT,
      enabled: true,
    });
  });

  it("strips a move confirmation without capturing anything", () => {
    // `?moved=1` is a notice with no event behind it. It still has to leave the
    // URL, or the confirmation reappears on every reload.
    render(<Harness initialSearch={{ moved: true }} />);
    expect(capture).not.toHaveBeenCalled();
    expect(outcome().moved).toBe(true);
    expect(url().moved).toBeUndefined();
  });

  it("does nothing at all on a URL that carries no outcome", () => {
    render(<Harness initialSearch={{ error: "boom" }} />);
    expect(capture).not.toHaveBeenCalled();
    expect(url().error).toBe("boom");
  });
});

describe("withoutSettingsOutcomeParams", () => {
  it("removes only the one-shot params", () => {
    expect(
      withoutSettingsOutcomeParams({
        saved: true,
        moved: true,
        kind: "announcing" as const,
        error: "boom",
      }),
    ).toEqual({ error: "boom" });
  });

  it("is a no-op on a URL that carries none of them", () => {
    expect(withoutSettingsOutcomeParams({ error: "boom" })).toEqual({
      error: "boom",
    });
  });
});
