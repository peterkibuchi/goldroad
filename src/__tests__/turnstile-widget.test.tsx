import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The widget's script costs every visitor its download and parse, and most
 * visitors to a page with a form never use the form. It loads only once the
 * form comes near the viewport or something in it takes focus.
 */
vi.mock("#/env", () => ({
  env: { VITE_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" },
}));

/** IntersectionObserver stand-in the test drives by hand. */
let intersect: (isIntersecting: boolean) => void = () => {};

beforeEach(() => {
  vi.resetModules();
  document.head.innerHTML = "";
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = (isIntersecting) =>
          callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const turnstileScripts = () =>
  document.head.querySelectorAll('script[src*="challenges.cloudflare.com"]');

async function renderForm() {
  const { TurnstileWidget } = await import("#/components/turnstile");
  return render(
    <form>
      <input aria-label="Email" name="email" />
      <TurnstileWidget />
    </form>,
  );
}

describe("TurnstileWidget — loads when the form is about to be used", () => {
  it("loads nothing while the form is far from the viewport", async () => {
    await renderForm();
    intersect(false);
    expect(turnstileScripts()).toHaveLength(0);
  });

  it("loads the script once the form nears the viewport", async () => {
    await renderForm();
    expect(turnstileScripts()).toHaveLength(0);
    intersect(true);
    intersect(true);
    expect(turnstileScripts()).toHaveLength(1);
  });

  it("loads the script when a field in the form takes focus", async () => {
    const { getByLabelText } = await renderForm();
    expect(turnstileScripts()).toHaveLength(0);
    fireEvent.focusIn(getByLabelText("Email"));
    expect(turnstileScripts()).toHaveLength(1);
  });
});

describe("turnstileReady — a submit that beats the challenge", () => {
  /** A loaded Turnstile API whose challenge the test solves by hand. */
  function fakeTurnstile() {
    const solve: Array<() => void> = [];
    const api = {
      render: vi.fn((_el: HTMLElement, params: Record<string, unknown>) => {
        solve.push(params.callback as () => void);
        return `widget-${solve.length}`;
      }),
      remove: vi.fn(),
      reset: vi.fn(),
    };
    vi.stubGlobal("turnstile", api);
    return { api, solve };
  }

  it("starts the challenge and waits for its token before the form is read", async () => {
    const { api, solve } = fakeTurnstile();
    const { container } = await renderForm();
    const { turnstileReady } = await import("#/components/turnstile");
    const form = container.querySelector("form") as HTMLFormElement;
    let ready = false;
    const waiting = turnstileReady(form).then(() => {
      ready = true;
    });
    await vi.waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    expect(ready).toBe(false);
    solve[0]();
    await waiting;
    expect(ready).toBe(true);
  });

  it("does not wait on a form without a widget", async () => {
    const { turnstileReady } = await import("#/components/turnstile");
    await expect(
      turnstileReady(document.createElement("form")),
    ).resolves.toBeUndefined();
  });

  it("still loads on focus where IntersectionObserver is missing", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { getByLabelText } = await renderForm();
    expect(turnstileScripts()).toHaveLength(0);
    fireEvent.focusIn(getByLabelText("Email"));
    expect(turnstileScripts()).toHaveLength(1);
  });

  it("renders nothing for a form that unmounted before the script arrived", async () => {
    const { api } = fakeTurnstile();
    const { unmount } = await renderForm();
    intersect(true);
    unmount();
    await Promise.resolve();
    expect(api.render).not.toHaveBeenCalled();
  });
});
