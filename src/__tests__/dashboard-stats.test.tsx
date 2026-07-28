import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// dashboard.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import type { DashboardRow } from "../lib/dashboard";
import { ReadersSection } from "../routes/dashboard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IDENT = "writer.example";

function row(rkey: string, title: string): DashboardRow {
  return {
    rkey,
    title,
    description: null,
    publishedAt: null,
    updatedAt: null,
    editable: true,
    announced: null,
  };
}

function stubStatsFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("ReadersSection — enabled: false (feature not configured)", () => {
  it("renders nothing at all, not even an empty container, once the fetch resolves", async () => {
    stubStatsFetch({ enabled: false });
    const { container } = render(
      <ReadersSection ident={IDENT} rows={[row("3aaa2aaa2aaa2", "a post")]} />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // Flush the effect's state update before asserting the DOM stays bare.
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("renders nothing before the fetch resolves either", () => {
    stubStatsFetch({ enabled: false });
    const { container } = render(
      <ReadersSection ident={IDENT} rows={[row("3aaa2aaa2aaa2", "a post")]} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("ReadersSection — enabled: true, data", () => {
  it("shows the total and a per-post views list joined by path", async () => {
    stubStatsFetch({
      enabled: true,
      total: 42,
      paths: [
        { path: `/@${IDENT}/3aaa2aaa2aaa2`, views: 30 },
        { path: `/@${IDENT}`, views: 12 },
      ],
    });
    render(
      <ReadersSection
        ident={IDENT}
        rows={[
          row("3aaa2aaa2aaa2", "the post with views"),
          row("3bbb2bbb2bbb2", "the post with no recorded views"),
        ]}
      />,
    );

    await screen.findByText("42");
    screen.getByText("all-time views");
    screen.getByText("the post with views");
    screen.getByText("30");
    // Absence isn't zero: a post the stats API never mentioned shows nothing.
    expect(screen.queryByText("the post with no recorded views")).toBeNull();
    screen.getByText(/approximate.*miss some readers/i);
  });

  it("still shows the total-views line when no post has a matching path", async () => {
    stubStatsFetch({
      enabled: true,
      total: 5,
      paths: [{ path: `/@${IDENT}`, views: 5 }],
    });
    render(
      <ReadersSection ident={IDENT} rows={[row("3aaa2aaa2aaa2", "post")]} />,
    );
    await screen.findByText("5");
    expect(screen.queryByText("post")).toBeNull();
  });
});

describe("ReadersSection — enabled: true, error: unavailable", () => {
  it("shows a single quiet line, no numbers", async () => {
    stubStatsFetch({ enabled: true, error: "unavailable" });
    render(<ReadersSection ident={IDENT} rows={[]} />);
    await screen.findByText(/catching their breath/i);
  });

  it("also falls back to the quiet line on a network/parse failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(<ReadersSection ident={IDENT} rows={[]} />);
    await screen.findByText(/catching their breath/i);
  });
});
