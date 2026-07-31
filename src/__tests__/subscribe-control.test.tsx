import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The subscribe control — the reader's one act on a writer's page.
 *
 * What these pin: current state comes from the reader's own repo through
 * /api/subscription and is never guessed; a press writes through the single
 * /api/publish handler carrying the publication and no record key; a reader
 * whose grant predates the subscription scope gets a sign-in prompt instead of a
 * button that does nothing; a signed-out reader gets a sign-in path back to the
 * page they were on; a state we could not read renders nothing rather than
 * "Subscribe"; and NO SURFACE EVER RENDERS A COUNT — not even a zero.
 */

// Only useLocation is needed (the sign-in return path), and it wants a live
// router context these cases don't set up — stubbed the same way the document
// article's suite stubs it.
const PATH = "/@writer.example/3lyk73wxnok2f";
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: PATH }),
}));

import { DocumentArticle } from "#/components/document-article";
import { SubscribeControl } from "#/components/subscribe-control";
import { PublicationView } from "#/routes/@{$handle}.index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WRITER = "did:plc:fake2222222222writer2222";
const PUB = `at://${WRITER}/site.standard.publication/3lyk73wxnok2f`;

type Answer = { body: unknown; status?: number };

/**
 * One stub for both endpoints the control talks to, so a case can say what the
 * state read and the write each answer. Returns the mock for call assertions.
 */
function stubWire(state: Answer, write: Answer = { body: { ok: true } }) {
  // `init` is declared even though the stub ignores it: the cases read it back
  // off the call to check the intent and the form the control posted.
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = typeof input === "string" ? input : String(input);
      const answer = url.startsWith("/api/subscription") ? state : write;
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SIGNED_OUT: Answer = { body: { ok: true, signedIn: false } };
const NOT_SUBSCRIBED: Answer = {
  body: { ok: true, signedIn: true, subscribed: false },
};
const SUBSCRIBED: Answer = {
  body: { ok: true, signedIn: true, subscribed: true },
};

function renderControl() {
  return render(<SubscribeControl publicationAtUri={PUB} />);
}

describe("SubscribeControl — current state", () => {
  it("asks about THIS publication, and asks the state endpoint for it", async () => {
    const fetchMock = stubWire(NOT_SUBSCRIBED);
    renderControl();
    await screen.findByRole("button", { name: "Subscribe" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/subscription?publication=${encodeURIComponent(PUB)}`,
    );
  });

  it("shows an unpressed Subscribe when the reader holds no subscription", async () => {
    stubWire(NOT_SUBSCRIBED);
    renderControl();
    const button = await screen.findByRole("button", { name: "Subscribe" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a pressed Subscribed when they already do", async () => {
    stubWire(SUBSCRIBED);
    renderControl();
    const button = await screen.findByRole("button", { name: "Subscribed" });
    // The toggle IS the state: one button, aria-pressed, no second label to
    // keep in sync and no separate Unsubscribe to find.
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("is a real button, keyboard-operable by default", async () => {
    stubWire(NOT_SUBSCRIBED);
    renderControl();
    const button = await screen.findByRole("button", { name: "Subscribe" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("renders nothing at all while the answer is still in flight", () => {
    stubWire(NOT_SUBSCRIBED);
    renderControl();
    // Deliberately not awaited: the pages are edge-cached without regard to
    // cookies, so this state cannot be in the HTML and the first paint has to
    // be honest about not knowing.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders NOTHING when the state could not be read", async () => {
    // A failed read is not "not subscribed" — those are opposite claims, and
    // the wrong one puts a Subscribe button in front of someone who already
    // subscribed. No button is the honest answer.
    stubWire({ body: { ok: false, error: "unavailable" }, status: 502 });
    renderControl();
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/subscrib/i)).toBeNull();
  });

  it("renders nothing when a signed-in answer omits the state entirely", async () => {
    stubWire({ body: { ok: true, signedIn: true } });
    renderControl();
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when there is no publication to subscribe to", () => {
    const fetchMock = stubWire(NOT_SUBSCRIBED);
    const { container } = render(<SubscribeControl publicationAtUri={null} />);
    expect(container.firstChild).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SubscribeControl — the signed-out reader", () => {
  it("offers a sign-in path instead of a dead button", async () => {
    stubWire(SIGNED_OUT);
    renderControl();
    const link = await screen.findByRole("link", {
      name: "Sign in to subscribe",
    });
    expect(link.getAttribute("href")).toBe(
      `/write?returnTo=${encodeURIComponent(PATH)}`,
    );
  });

  it("names where the reader was, so signing in returns them to the page", async () => {
    stubWire(SIGNED_OUT);
    renderControl();
    const link = await screen.findByRole("link", {
      name: "Sign in to subscribe",
    });
    // Verbatim: the single open-redirect guard is safeReturnTo on the /login
    // POST, the only place this value can become a Location.
    expect(
      decodeURIComponent(
        new URL(
          link.getAttribute("href") ?? "",
          "https://x.test",
        ).searchParams.get("returnTo") ?? "",
      ),
    ).toBe(PATH);
  });

  it("never writes anything for a signed-out reader", async () => {
    const fetchMock = stubWire(SIGNED_OUT);
    renderControl();
    await screen.findByRole("link", { name: "Sign in to subscribe" });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/publish"),
    ).toBe(false);
  });
});

describe("SubscribeControl — pressing it", () => {
  it("subscribes through the single write path, carrying the publication", async () => {
    const fetchMock = stubWire(NOT_SUBSCRIBED, {
      body: { ok: true, subscribed: true },
      status: 201,
    });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));

    await screen.findByRole("button", { name: "Subscribed" });
    const write = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/publish",
    );
    expect(write).toBeDefined();
    const init = write?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("intent")).toBe("subscribe");
    expect(form.get("publication")).toBe(PUB);
    // No record key from the page: the handler looks up the one it acts on.
    expect(form.get("rkey")).toBeNull();
  });

  it("unsubscribes when pressed while subscribed", async () => {
    const fetchMock = stubWire(SUBSCRIBED, {
      body: { ok: true, subscribed: false },
    });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribed" }));

    await screen.findByRole("button", { name: "Subscribe" });
    const form = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/publish",
    )?.[1] as RequestInit;
    expect((form.body as FormData).get("intent")).toBe("unsubscribe");
  });

  it("announces the change, not just repaints it", async () => {
    stubWire(NOT_SUBSCRIBED, { body: { ok: true, subscribed: true } });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
    // A live region carries the outcome for a reader who can't see the label
    // change under their own finger.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Subscribed.");
    });
  });

  it("announces the removal too", async () => {
    stubWire(SUBSCRIBED, { body: { ok: true, subscribed: false } });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribed" }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Subscription removed.",
      );
    });
  });
});

describe("SubscribeControl — when the write can't happen", () => {
  it("prompts a fresh sign-in when the grant predates the subscription scope", async () => {
    // Sessions older than the scope can read but not write subscriptions. The
    // control must say so — a button that silently does nothing is the failure
    // this replaces.
    stubWire(NOT_SUBSCRIBED, {
      body: { ok: false, error: "subscription_scope" },
      status: 403,
    });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Sign in again to subscribe.");
    expect(alert.querySelector("a")?.getAttribute("href")).toBe(
      `/write?returnTo=${encodeURIComponent(PATH)}`,
    );
  });

  it("leaves the button in its old state after a refused write", async () => {
    stubWire(NOT_SUBSCRIBED, {
      body: { ok: false, error: "subscription_scope" },
      status: 403,
    });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
    await screen.findByRole("alert");
    // Nothing was written, so nothing may claim it was.
    const button = screen.getByRole("button", { name: "Subscribe" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("prompts a fresh sign-in on an expired session", async () => {
    stubWire(NOT_SUBSCRIBED, {
      body: { ok: false, error: "session_expired" },
      status: 401,
    });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign in again to subscribe.",
    );
  });

  it("treats a bare 401 the same way — the handler answers it before any JSON", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/subscription")
        ? new Response(JSON.stringify(NOT_SUBSCRIBED.body))
        : new Response("Not signed in", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign in again to subscribe.",
    );
  });

  it("says what to do next when the write simply failed", async () => {
    stubWire(NOT_SUBSCRIBED, {
      body: { ok: false, error: "subscribe_failed" },
      status: 502,
    });
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That didn't go through — try again.",
    );
  });

  it("treats an HTML error page as a failure, never as success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/subscription")
        ? new Response(JSON.stringify(NOT_SUBSCRIBED.body))
        : new Response("<html>502</html>", { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe" }));
    await screen.findByRole("alert");
    expect(
      screen
        .getByRole("button", { name: "Subscribe" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("survives a network that isn't there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderControl();
    // A read that never arrived renders nothing, and nothing throws.
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("no subscriber count, anywhere", () => {
  // Counting the repos pointing at a publication needs a firehose indexer we
  // don't run, so there is no number to show — and "0" would be a made-up one.
  for (const [label, state] of [
    ["not subscribed", NOT_SUBSCRIBED],
    ["subscribed", SUBSCRIBED],
    ["signed out", SIGNED_OUT],
  ] as const) {
    it(`renders no number beside the control — ${label}`, async () => {
      stubWire(state);
      const { container } = render(<SubscribeControl publicationAtUri={PUB} />);
      await waitFor(() => {
        expect(vi.mocked(fetch)).toHaveBeenCalled();
      });
      expect(container.textContent).not.toMatch(/\d/);
      expect(container.textContent).not.toMatch(/subscriber/i);
    });
  }
});

describe("the reading surfaces carry it", () => {
  const doc = {
    title: "Publishing on the open network",
    textContent: "Full body text here.",
    publishedAt: "2026-01-05T00:00:00.000Z",
  };

  it("puts the control in the post's end-of-post card", async () => {
    stubWire(NOT_SUBSCRIBED);
    render(
      <DocumentArticle
        doc={doc}
        ident="writer.example"
        publicationAtUri={PUB}
        publicationName="The Long Way"
      />,
    );
    await screen.findByRole("button", { name: "Subscribe" });
    // It leads the card's row, ahead of the two links that hand the reader off
    // to somebody else's surface.
    expect(
      screen.getByRole("link", { name: /Follow @writer\.example/ }),
    ).toBeDefined();
  });

  it("offers nothing to subscribe to on a document with no publication record", async () => {
    stubWire(NOT_SUBSCRIBED);
    render(<DocumentArticle doc={doc} ident="writer.example" />);
    await screen.findByRole("link", { name: /Follow @writer\.example/ });
    expect(screen.queryByRole("button", { name: /Subscribe/ })).toBeNull();
  });

  it("puts the control in the publication masthead", async () => {
    stubWire(NOT_SUBSCRIBED);
    render(
      <PublicationView
        ident="writer.example"
        iconPath={null}
        nextCursor={null}
        posts={[]}
        publication={null}
        publicationAtUri={PUB}
      />,
    );
    await screen.findByRole("button", { name: "Subscribe" });
  });

  it("shows no count on the publication page either", async () => {
    stubWire(SUBSCRIBED);
    const { container } = render(
      <PublicationView
        ident="writer.example"
        iconPath={null}
        nextCursor={null}
        posts={[]}
        publication={null}
        publicationAtUri={PUB}
      />,
    );
    await screen.findByRole("button", { name: "Subscribed" });
    // No "0 subscribers", no "1 subscriber", no bare number near the control.
    expect(container.textContent).not.toMatch(/subscriber/i);
  });
});
