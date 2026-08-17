import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The two surfaces below reach for useLocation (the report link, the subscribe
// control's sign-in path) and want a live router context these cases don't set
// up — stubbed the way the document article's own suite stubs it.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example/3lyk73wxnok2f" }),
}));

import { DocumentArticle } from "#/components/document-article";
import { ReaderEmailCapture } from "#/components/reader-email-capture";
import { PublicationView } from "#/routes/@{$handle}.index";

/**
 * The reader email capture, on the two reading surfaces that carry it.
 *
 * Four things here are rules rather than preferences, and each has a failure it
 * prevents:
 *
 *   1. It renders NOTHING for a publication this instance doesn't host. These
 *      pages render any atproto author, so without the gate we would collect
 *      addresses on behalf of writers with no account here — people who could
 *      never receive them, named as their controller.
 *   2. The copy promises no date and uses no invite language. There is no gate
 *      behind this field and sending isn't built; both halves have to be said
 *      plainly (`marketing-claims.test.ts` exists because that failed three
 *      times in copy nobody was watching).
 *   3. It works without JavaScript — a real form, a real action, a real method.
 *      The fetch path is an enhancement over that floor, not the floor.
 *   4. No accent colour. A reading page's one accent moment belongs to the
 *      writer's words, and this control is ours (see subscribe-control).
 */

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WRITER = "did:plc:fake2222222222writer2222";
const OURS = "https://trygoldroad.com/@writer.example";

function renderCapture(
  props: Partial<Parameters<typeof ReaderEmailCapture>[0]> = {},
) {
  return render(
    <ReaderEmailCapture
      ident="writer.example"
      publicationName="Field Notes"
      publicationUrl={OURS}
      source="post"
      writerDid={WRITER}
      {...props}
    />,
  );
}

function okFetch() {
  // The parameters are declared even though the stub ignores them: the cases
  // read the URL and the body back off the call.
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ ok: true }));
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function form(): HTMLFormElement {
  const el = document.querySelector("form");
  if (!el) throw new Error("no capture form rendered");
  return el;
}

function fill(email: string): void {
  fireEvent.change(screen.getByLabelText(/new posts by email/i), {
    target: { value: email },
  });
}

describe("ReaderEmailCapture — who it appears for", () => {
  it("offers nothing on a publication hosted somewhere else", () => {
    // A Leaflet author's essays render here exactly as ours do. Their readers'
    // addresses are not ours to take on their behalf.
    const { container } = renderCapture({
      publicationUrl: "https://writer.leaflet.pub",
    });
    expect(container.innerHTML).toBe("");
  });

  it("offers nothing for a publication with no url at all", () => {
    const { container } = renderCapture({ publicationUrl: null });
    expect(container.innerHTML).toBe("");
  });

  it("offers nothing when there is no writer to hold the address", () => {
    const { container } = renderCapture({ writerDid: null });
    expect(container.innerHTML).toBe("");
  });

  it("appears on a publication this instance hosts", () => {
    renderCapture();
    expect(screen.getByLabelText(/new posts by email/i)).toBeDefined();
  });

  it("also recognizes a publication url minted under a legacy origin", () => {
    // Records created before the canonical-origin move are still ours.
    renderCapture({
      publicationUrl: "https://goldroad.kibuchi.workers.dev/@writer.example",
    });
    expect(screen.getByLabelText(/new posts by email/i)).toBeDefined();
  });
});

describe("the two surfaces that carry it", () => {
  /** Both surfaces mount the subscribe control, which reads its own state on
   * mount. Nothing here is about that; answer it and move on. */
  function stubSubscriptionRead() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, signedIn: false }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  it("sits in the post colophon, where the reading surface reserved it", async () => {
    stubSubscriptionRead();
    render(
      <DocumentArticle
        did={WRITER}
        doc={{ title: "On the open network", textContent: "Words." }}
        ident="writer.example"
        publicationName="Field Notes"
        publicationUrl={OURS}
      />,
    );
    const field = await screen.findByLabelText(/new posts by email/i);
    expect(field.closest("aside")).not.toBeNull();
    expect(field.getAttribute("name")).toBe("email");
    // The surface's own source is what the row records.
    expect(
      field
        .closest("form")
        ?.querySelector<HTMLInputElement>('input[name="source"]')?.value,
    ).toBe("post");
  });

  it("sits in the publication masthead too — a reader from a profile link has no colophon", async () => {
    stubSubscriptionRead();
    render(
      <PublicationView
        did={WRITER}
        ident="writer.example"
        iconPath={null}
        nextCursor={null}
        posts={[]}
        publication={{ name: "Field Notes", url: OURS }}
      />,
    );
    const field = await screen.findByLabelText(/new posts by email/i);
    expect(
      field
        .closest("form")
        ?.querySelector<HTMLInputElement>('input[name="source"]')?.value,
    ).toBe("publication");
  });

  it("offers nothing on a post whose publication lives on another app", async () => {
    stubSubscriptionRead();
    render(
      <DocumentArticle
        did={WRITER}
        doc={{ title: "Elsewhere", textContent: "Words." }}
        ident="writer.example"
        publicationName="Notes from Elsewhere"
        publicationUrl="https://writer.leaflet.pub"
      />,
    );
    await screen.findByText("Elsewhere");
    expect(screen.queryByLabelText(/new posts by email/i)).toBeNull();
  });
});

describe("ReaderEmailCapture — what it says", () => {
  it("states that sending isn't switched on, without naming a date", () => {
    const { container } = renderCapture();
    const text = container.textContent ?? "";
    expect(text).toMatch(/isn't switched on/i);
    expect(text).not.toMatch(
      /soon|shortly|coming|any day|next (week|month)|\b20\d\d\b/i,
    );
  });

  it("uses no invite language", () => {
    // There is no invite gate on the other side of this field, and there never
    // was one to wait for.
    expect(renderCapture().container.textContent ?? "").not.toMatch(
      /invit|early access|waitlist|beta list/i,
    );
  });

  it("names the publication, and falls back to the handle", () => {
    expect(renderCapture().container.textContent).toContain("Field Notes");
    cleanup();
    expect(
      renderCapture({ publicationName: null }).container.textContent,
    ).toContain("@writer.example");
  });

  it("links to how the address is held before asking for it", () => {
    renderCapture();
    const privacy = screen.getByRole("link", { name: /how it's held/i });
    expect(privacy.getAttribute("href")).toBe("/privacy");
  });

  it("spends no accent colour — the page's is the writer's", () => {
    const { container } = renderCapture();
    const spot = [...container.querySelectorAll<HTMLElement>("[class]")].filter(
      (el) =>
        [...el.classList].some((token) =>
          /^(?:bg-spot|text-spot|border-spot|outline-spot|spot-highlight)/.test(
            token,
          ),
        ),
    );
    expect(spot).toEqual([]);
  });
});

describe("ReaderEmailCapture — without JavaScript", () => {
  it("is a real form that posts itself to the endpoint", () => {
    renderCapture();
    expect(form().getAttribute("action")).toBe("/api/subscribe");
    expect(form().getAttribute("method")).toBe("post");
  });

  it("carries every field the endpoint needs in the markup itself", () => {
    renderCapture();
    const named = (name: string) =>
      form().querySelector<HTMLInputElement>(`input[name="${name}"]`);
    expect(named("email")?.required).toBe(true);
    expect(named("email")?.type).toBe("email");
    expect(named("writerDid")?.value).toBe(WRITER);
    expect(named("source")?.value).toBe("post");
    expect(named("ident")?.value).toBe("writer.example");
  });

  it("keeps the honeypot out of the accessibility tree", () => {
    renderCapture();
    const honeypot = form().querySelector<HTMLInputElement>(
      'input[name="gr_extra"]',
    );
    expect(honeypot?.getAttribute("aria-hidden")).toBe("true");
    expect(honeypot?.tabIndex).toBe(-1);
  });

  it("holds the 16px floor on the one control a reader taps", () => {
    // A control under 16px zooms iOS Safari in on focus and never back out, and
    // this is a public page a phone visitor meets first.
    renderCapture();
    const email = screen.getByLabelText(/new posts by email/i);
    expect(email.className).toContain("text-base");
    expect(email.className.split(/\s+/)).not.toContain("text-sm");
  });
});

describe("ReaderEmailCapture — with JavaScript", () => {
  it("posts the address to /api/subscribe and confirms in place", async () => {
    const fetcher = okFetch();
    renderCapture({ source: "publication" });
    fill("Reader@Example.com");
    fireEvent.submit(form());

    expect(await screen.findByText(/nothing will arrive today/i)).toBeDefined();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/subscribe");
    expect(JSON.parse(String(init.body))).toEqual({
      gr_extra: "",
      email: "Reader@Example.com",
      writerDid: WRITER,
      source: "publication",
      ident: "writer.example",
    });
  });

  it("sets expectations in the confirmation, not just thanks", async () => {
    okFetch();
    renderCapture();
    fill("reader@example.com");
    fireEvent.submit(form());

    const confirmation = await screen.findByText(/nothing will arrive today/i);
    expect(confirmation).toBeDefined();
    // Announced too: the form it replaced was what the reader was looking at.
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(
      /has your address/i,
    );
  });

  it("navigates nowhere on success — no modal, no page change", async () => {
    okFetch();
    renderCapture();
    fill("reader@example.com");
    fireEvent.submit(form());
    await screen.findByText(/nothing will arrive today/i);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("says what to do next when the submit fails, and keeps the address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 400 })),
    );
    renderCapture();
    fill("reader@example.com");
    fireEvent.submit(form());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/try again/i);
    // The form is still there to try again in.
    expect(screen.getByLabelText(/new posts by email/i)).toBeDefined();
  });

  it("reports nothing about the reader to analytics", async () => {
    // The one property policy that matters here: an address is never an event.
    const fetcher = okFetch();
    renderCapture();
    fill("reader@example.com");
    fireEvent.submit(form());
    await screen.findByText(/nothing will arrive today/i);
    expect(fetcher.mock.calls.every(([url]) => url === "/api/subscribe")).toBe(
      true,
    );
  });
});
