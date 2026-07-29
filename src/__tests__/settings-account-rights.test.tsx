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

// settings.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { DeleteAccountForm, ExportDataButton } from "../routes/settings";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

// jsdom doesn't implement <dialog>'s modal API — same minimal stand-in as
// dashboard-delete.test.tsx.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

describe("DeleteAccountForm — the highest-stakes confirm on the page", () => {
  const submits: { defaultPrevented: boolean }[] = [];
  const recordSubmit = (event: Event) => {
    submits.push({ defaultPrevented: event.defaultPrevented });
    event.preventDefault(); // jsdom can't perform the real navigation
  };

  beforeEach(() => {
    submits.length = 0;
    window.addEventListener("submit", recordSubmit);
    return () => window.removeEventListener("submit", recordSubmit);
  });

  it("always opens the real dialog — no window.confirm branch", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { container } = render(<DeleteAccountForm ident="sana.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(container.querySelector("dialog")?.open).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(submits.every((s) => s.defaultPrevented)).toBe(true);
  });

  it("states the real consequence: our copies are gone, published work and Bluesky posts are not", () => {
    render(<DeleteAccountForm ident="sana.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("drafts, import history, and sign-in");
    expect(dialog.textContent).toContain(
      "does NOT delete anything you've published",
    );
    expect(dialog.textContent).toContain("Bluesky stay up too");
  });

  it("links to the writer's own public page as proof it survives deletion", () => {
    render(<DeleteAccountForm ident="sana.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const link = screen.getByRole("link", { name: /view your public page/i });
    expect(link.getAttribute("href")).toBe("/@sana.example");
  });

  it("Cancel closes without submitting; the dialog's own button proceeds", () => {
    const { container } = render(<DeleteAccountForm ident="sana.example" />);
    const dialog = () => container.querySelector("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()?.open).toBe(false);
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(dialog()?.open).toBe(false);
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(1);
  });

  it("posts to /api/account/delete", () => {
    const { container } = render(<DeleteAccountForm ident="sana.example" />);
    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/api/account/delete");
    expect(form?.getAttribute("method")).toBe("post");
  });
});

describe("ExportDataButton — download-your-data", () => {
  const originalFetch = global.fetch;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:fake-url");
    revokeObjectURL = vi.fn();
    const mutableUrl = URL as unknown as {
      createObjectURL: typeof createObjectURL;
      revokeObjectURL: typeof revokeObjectURL;
    };
    mutableUrl.createObjectURL = createObjectURL;
    mutableUrl.revokeObjectURL = revokeObjectURL;
    // jsdom doesn't implement the `download` attribute, so a real anchor
    // click attempts (and logs a noisy "not implemented") navigation — the
    // component only cares that `.click()` was called, not that it navigates.
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("downloads the response as a blob named from content-disposition", async () => {
    const blob = new Blob(["{}"], { type: "application/json" });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(blob, {
        headers: {
          "content-disposition":
            'attachment; filename="goldroad-data-2026-07-29.json"',
        },
        status: 200,
      }),
    ) as unknown as typeof fetch;

    render(<ExportDataButton />);
    fireEvent.click(
      screen.getByRole("button", { name: /download your data/i }),
    );

    await screen.findByRole("button", { name: /download your data/i });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/account/export",
      expect.objectContaining({ method: "POST" }),
    );
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });

  it("shows an inline error when the request fails, and stays clickable", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 500 }),
      ) as unknown as typeof fetch;

    render(<ExportDataButton />);
    fireEvent.click(
      screen.getByRole("button", { name: /download your data/i }),
    );

    expect(await screen.findByText(/didn't go through/i)).toBeDefined();
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: /download your data/i,
    });
    expect(button.disabled).toBe(false);
  });
});
