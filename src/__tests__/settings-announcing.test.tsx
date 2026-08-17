import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// settings.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { AnnounceSetting } from "../routes/settings";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

/**
 * The account-level announce switch, and mostly the ONE SENTENCE beside it.
 *
 * Announcing is on by default, so the only decision this control offers is to
 * turn it off — and a writer making that decision has to be able to see what it
 * costs before they save it, not discover it a week later when a post reached
 * nobody. That sentence is therefore the feature here, not decoration, and it
 * has to appear at the moment the box is unticked rather than on the reload
 * afterwards.
 *
 * It is also deliberately NOT a warning. Publishing quietly is a legitimate
 * thing to want, and an interface that flinches when you choose it is an
 * interface arguing with you.
 */
const CONSEQUENCE =
  /don't reach your followers' timelines and have no conversation on Bluesky/i;

const box = () => screen.getByRole("checkbox");

describe("AnnounceSetting — the switch", () => {
  it("starts from the writer's stored setting", () => {
    render(<AnnounceSetting enabled={true} />);
    expect((box() as HTMLInputElement).checked).toBe(true);
    cleanup();
    render(<AnnounceSetting enabled={false} />);
    expect((box() as HTMLInputElement).checked).toBe(false);
  });

  it("names itself by what it does for the writer", () => {
    render(<AnnounceSetting enabled={true} />);
    screen.getByRole("checkbox", { name: /announce new posts on bluesky/i });
  });

  it("says where the per-post override lives, and that using it changes nothing here", () => {
    // A writer who unticks the box on every post is a writer who wants THIS
    // setting changed, and vice versa; neither can be guessed at.
    render(<AnnounceSetting enabled={true} />);
    const help = screen.getByText(/publish screen/i);
    expect(help.textContent).toMatch(/never changes this setting/i);
  });

  it("posts to the one write handler, as an account preference and not a record", () => {
    const { container } = render(<AnnounceSetting enabled={true} />);
    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/api/publish");
    expect(form?.getAttribute("method")).toBe("post");
    expect(
      container.querySelector<HTMLInputElement>('input[name="intent"]')?.value,
    ).toBe("announce-prefs");
  });

  it("submits the box's own value, so unticked posts nothing at all", () => {
    // An unchecked checkbox sends no field, which is exactly the value the
    // handler needs to store — "off" rather than "no change".
    render(<AnnounceSetting enabled={true} />);
    expect(box().getAttribute("name")).toBe("autoAnnounce");
    expect((box() as HTMLInputElement).value).toBe("1");
  });
});

describe("AnnounceSetting — the consequence of turning it off", () => {
  it("is silent while announcing is on", () => {
    render(<AnnounceSetting enabled={true} />);
    expect(screen.queryByText(CONSEQUENCE)).toBeNull();
  });

  it("appears the moment the box is unticked, before anything is saved", () => {
    render(<AnnounceSetting enabled={true} />);
    fireEvent.click(box());
    expect((box() as HTMLInputElement).checked).toBe(false);
    screen.getByText(CONSEQUENCE);
  });

  it("is already on screen for a writer who saved it off", () => {
    // Also the no-JavaScript path's answer: the form posts, the page reloads,
    // and the same words are there.
    render(<AnnounceSetting enabled={false} />);
    screen.getByText(CONSEQUENCE);
  });

  it("goes away again when the writer changes their mind", () => {
    render(<AnnounceSetting enabled={false} />);
    screen.getByText(CONSEQUENCE);
    fireEvent.click(box());
    expect(screen.queryByText(CONSEQUENCE)).toBeNull();
  });

  it("names the way back — announcing by hand is still there", () => {
    render(<AnnounceSetting enabled={false} />);
    expect(screen.getByText(CONSEQUENCE).textContent).toMatch(
      /by hand from your posts page/i,
    );
  });

  it("is a fact in the quiet register, not an alert", () => {
    // spot is this app's accent AND its error colour; using it here would read
    // as "you have done something wrong".
    render(<AnnounceSetting enabled={false} />);
    const line = screen.getByText(CONSEQUENCE);
    expect(line.className).toContain("text-ink-soft");
    expect(line.className).not.toContain("text-spot");
    expect(line.getAttribute("role")).not.toBe("alert");
  });

  it("is announced to a screen reader at the moment of the choice", () => {
    // It is rendered into a live region that exists in the DOM whether or not
    // it has words in it, so the swap is an update rather than an insertion.
    render(<AnnounceSetting enabled={true} />);
    const live = screen
      .getByRole("checkbox")
      .closest("form")
      ?.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    fireEvent.click(box());
    expect(live?.textContent).toMatch(CONSEQUENCE);
  });

  it("describes the checkbox rather than floating loose", () => {
    render(<AnnounceSetting enabled={true} />);
    expect(box().getAttribute("aria-describedby")).toBe("auto-announce-help");
    expect(document.getElementById("auto-announce-help")).not.toBeNull();
  });
});

describe("AnnounceSetting — the accent budget", () => {
  it("saves with the ink vocabulary, not the page's accent", () => {
    // The command rail's "New post" spends this surface's one accent moment
    // (docs/DESIGN.md); a page-level primary takes ink and reaches for spot on
    // hover only. page-accent-budget.test.tsx guards the whole file — this
    // pins the pairing on the button itself.
    render(<AnnounceSetting enabled={true} />);
    const save = screen.getByRole("button", { name: /save announcing/i });
    expect(save.className).toContain("bg-ink");
    expect(save.className).toContain("hover:bg-spot");
    expect(save.className).not.toMatch(/(?<![\w:-])bg-spot(?![\w-])/);
  });

  it("keeps the save target big enough to hit", () => {
    render(<AnnounceSetting enabled={true} />);
    expect(
      screen.getByRole("button", { name: /save announcing/i }).className,
    ).toContain("min-h-11");
  });
});
