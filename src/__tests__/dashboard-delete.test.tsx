import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// dashboard.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { DeletePostForm } from "../routes/dashboard";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

// jsdom doesn't implement <dialog>'s modal API — a minimal stand-in that
// tracks the open state is enough for these tests.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

const ANNOUNCED = { did: "did:plc:abc123", postRkey: "3lbskypost01" };

describe("dashboard delete — announce-aware confirm", () => {
  const submits: { defaultPrevented: boolean }[] = [];
  const recordSubmit = (event: Event) => {
    // Recorded first, then suppressed: jsdom can't perform the navigation.
    submits.push({ defaultPrevented: event.defaultPrevented });
    event.preventDefault();
  };
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    submits.length = 0;
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.addEventListener("submit", recordSubmit);
    return () => {
      window.removeEventListener("submit", recordSubmit);
      confirmSpy.mockRestore();
    };
  });

  it("announced: Delete opens a dialog naming the real consequence, with the Bluesky link", () => {
    const { container } = render(
      <DeletePostForm announced={ANNOUNCED} rkey="3lpost01" title="My post" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = container.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    // The consequence in plain language — the announcement is NOT deleted.
    expect(dialog?.textContent).toContain("stays up");
    expect(dialog?.textContent).toContain("no longer exists");
    const link = screen.getByRole("link", { name: /view the bluesky post/i });
    // The DID must be RAW — bsky.app's router rejects percent-encoded colons.
    expect(link.getAttribute("href")).toBe(
      `https://bsky.app/profile/${ANNOUNCED.did}/post/${ANNOUNCED.postRkey}`,
    );
    expect(link.getAttribute("href")).not.toContain("%3A");
    expect(link.getAttribute("target")).toBe("_blank");
    // The dialog replaces window.confirm entirely here.
    expect(confirmSpy).not.toHaveBeenCalled();
    // The initial submit was intercepted, nothing went through.
    expect(submits.every((s) => s.defaultPrevented)).toBe(true);
  });

  it("announced: Cancel closes without deleting; the dialog's Delete proceeds", () => {
    const { container } = render(
      <DeletePostForm announced={ANNOUNCED} rkey="3lpost01" title="My post" />,
    );
    const dialog = () => container.querySelector("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()?.open).toBe(false);
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete the post" }));
    expect(dialog()?.open).toBe(false);
    // Exactly one submit went through un-prevented — the approved one.
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(1);
  });

  it("not announced: keeps the plain confirm, no dialog rendered", () => {
    const { container } = render(
      <DeletePostForm announced={null} rkey="3lpost02" title="Quiet post" />,
    );
    expect(container.querySelector("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete "Quiet post" from your repo? This can\'t be undone.',
    );
    // confirm returned false → prevented.
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(0);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(1);
  });
});
