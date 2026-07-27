import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// write.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { SaveIndicator } from "../routes/write";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("SaveIndicator — the autosave status line", () => {
  it("is a polite live region (role=status announces without stealing focus)", () => {
    render(<SaveIndicator state="saving" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("speaks each state in the calm register — text only, no spinner", () => {
    render(<SaveIndicator state="saving" />);
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    cleanup();

    render(<SaveIndicator state="saved" />);
    expect(screen.getByRole("status").textContent).toBe("Saved");
    cleanup();

    render(<SaveIndicator state="error" />);
    expect(screen.getByRole("status").textContent).toContain("Couldn't save");
    cleanup();

    render(<SaveIndicator state="limit" />);
    expect(screen.getByRole("status").textContent).toContain("50 drafts");
  });

  it("stays present-but-silent when idle (the region exists for later updates)", () => {
    render(<SaveIndicator state="idle" />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
