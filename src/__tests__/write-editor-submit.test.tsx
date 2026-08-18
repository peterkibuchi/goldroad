import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Regression guard for the add-block-publishes bug: BlockNote's internal UI
// buttons (side-menu +, drag handle, slash-menu items) don't set
// type="button", and a type-less button inside a form is a SUBMIT button.
// The editor therefore must never be a descendant of the publish <form>.
// The mock stands in for BlockNote with exactly that hazard: a type-less
// button rendered where the editor mounts.
// What the fake editor projects to markdown. Mutable so a test can make the
// document longer than a post is allowed to be — the client-side length
// refusal is the one refusal that must never reach the server, because the
// draft row shares the cap and so cannot hold the words while we redirect.
const markdown = vi.hoisted(() => ({ current: "body text" }));

vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  // One STABLE instance, like the real useCreateBlockNote: onReady fires per
  // effect run, and Compose's setEditor must bail out on an identical value
  // (a fresh object each run would loop the update cycle forever).
  const fakeEditor = {
    document: [],
    blocksToMarkdownLossy: () => markdown.current,
  };
  return {
    default: function FakeEditor({
      onReady,
    }: {
      onReady: (editor: unknown) => void;
    }) {
      useEffect(() => {
        onReady(fakeEditor);
      }, [onReady]);
      return (
        <div data-testid="editor-region">
          {/* biome-ignore lint/a11y/useButtonType: the missing type IS the hazard under test */}
          <button>+</button>
        </div>
      );
    },
  };
});

import { MAX_BODY_LENGTH } from "../lib/publish";
// write.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { Compose } from "../routes/write";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

// Mounting this route the first time carries a one-time cost that has nothing
// to do with what these tests assert: resolving the
// `lazy(() => import("~/components/editor"))` chunk, plus first-call warmup of
// React's render path and testing-library's role engine. Measured on a busy
// box that first mount takes seconds while later ones take ~100ms — so left
// where it falls it lands inside the FIRST test's findBy* window and that test
// alone fails on machine load rather than on behaviour.
//
// Do it once here, off the clock, and every wait below covers only rendering.
// This is a warmup, not a fixture: each test still mounts its own Compose.
beforeAll(async () => {
  render(
    <Compose
      draft={null}
      error={undefined}
      reconnectHandle={null}
      resumed={null}
    />,
  );
  await screen.findByRole("button", { name: "+" }, { timeout: 30_000 });
  cleanup();
}, 60_000);

describe("/write — editor buttons must never submit the publish form", () => {
  let submitSpy: ReturnType<typeof vi.spyOn>;
  const submitEvents: SubmitEvent[] = [];
  const recordSubmit = (event: Event) => {
    submitEvents.push(event as SubmitEvent);
    // Recorded first, then suppressed: jsdom can't perform the navigation.
    event.preventDefault();
  };

  beforeEach(() => {
    submitEvents.length = 0;
    submitSpy = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    window.addEventListener("submit", recordSubmit);
    return () => {
      window.removeEventListener("submit", recordSubmit);
      submitSpy.mockRestore();
    };
  });

  async function renderCompose() {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    // The editor is lazy + ClientOnly — wait for the mock to mount.
    return await screen.findByRole("button", { name: "+" });
  }

  it("keeps the editor region outside the form element", async () => {
    const plus = await renderCompose();
    const form = document.getElementById("publish-form");
    expect(form).toBeInstanceOf(HTMLFormElement);
    expect(form?.contains(plus)).toBe(false);
    // No form owner at all: even implicit submission can't reach it.
    expect((plus as HTMLButtonElement).form).toBeNull();
  });

  it("clicking a type-less button inside the editor does not submit", async () => {
    const plus = await renderCompose();
    fireEvent.click(plus);
    expect(submitEvents).toHaveLength(0);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("the Publish button still submits the form from outside it", async () => {
    await renderCompose();
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A title" },
    });
    fireEvent.click(publish);
    // handleSubmit intercepts the event, exports the blocks, then submits
    // for real via form.submit() (spied here).
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
  });
});

/**
 * A rejected publish sends the writer back to `/write?draft=…`, so the draft
 * row is what they get handed back. That only helps if the row is CURRENT —
 * and clicking Publish clears the pending autosave timer, so words typed in
 * the seconds before the click had never reached D1. They were invisible while
 * publishes succeeded, and were exactly what a refusal lost.
 */
describe("/write — publishing flushes the draft first", () => {
  const calls: string[] = [];
  let submitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    calls.length = 0;
    submitSpy = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {
        calls.push("submit");
      });
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      calls.push(`fetch:${String(input)}`);
      return Promise.resolve(
        new Response(JSON.stringify({ draft: { id: FRESH_DRAFT_ID } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    return () => {
      submitSpy.mockRestore();
      vi.unstubAllGlobals();
    };
  });

  const FRESH_DRAFT_ID = "99999999-8888-4777-8666-555555555555";

  async function composeAndPublish() {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    // Typing marks the draft dirty; the debounce has not fired yet.
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Words typed a moment ago" },
    });
    fireEvent.click(publish);
    await waitFor(() => expect(calls).toContain("submit"));
    return publish;
  }

  it("saves the draft before submitting, not after", async () => {
    await composeAndPublish();
    const saved = calls.findIndex((c) => c.startsWith("fetch:/api/drafts"));
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(saved).toBeLessThan(calls.indexOf("submit"));
  });

  it("sends the id of the draft that flush just created", async () => {
    await composeAndPublish();
    // Without the flush this field is empty for a first-ever publish, and a
    // refusal has nothing to point the writer at.
    const field = document.querySelector<HTMLInputElement>(
      "#publish-form input[name='draftId']",
    );
    expect(field?.value).toBe(FRESH_DRAFT_ID);
  });

  it("publishes anyway when the flush fails", async () => {
    const attempted: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      attempted.push(String(input));
      return Promise.reject(new Error("offline"));
    });
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A title" },
    });
    fireEvent.click(publish);
    // The words ride the form body regardless. Refusing to publish because a
    // draft write flaked would trade a working publish for a better fallback.
    await waitFor(() => expect(calls).toContain("submit"));
    // And the flush was genuinely attempted — without this the test passes on
    // any build that never flushes at all.
    expect(attempted.some((u) => u.startsWith("/api/drafts"))).toBe(true);
  });

  it("recreates a draft deleted elsewhere instead of publishing past it", async () => {
    // Another tab (or a scheduled publish) removed the row while this editor
    // had it open. The flush 404s. Recreating is the only thing that keeps a
    // refused publish able to hand the words back — and the guard that used to
    // suppress it during a publish was written for the OPPOSITE case, a late
    // autosave arriving after the server deleted the completed draft.
    const posted: string[] = [];
    let first = true;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      calls.push(`fetch:${String(input)}`);
      if (first) {
        first = false;
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ draft: { id: FRESH_DRAFT_ID } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={{
          id: "12121212-3434-4565-8787-909090909090",
          title: "Resumed",
          dek: "",
          blocksJson: "[]",
          markdown: "",
          inlineImages: "",
          schedule: null,
          imported: false,
        }}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Resumed, revised" },
    });
    fireEvent.click(publish);
    await waitFor(() => expect(calls).toContain("submit"));
    // Two saves: the one that 404'd, then a create with no id.
    expect(posted).toHaveLength(2);
    expect(JSON.parse(posted[1]).id).toBeUndefined();
    // And the publish carries the recreated row, not the dead one.
    const field = document.querySelector<HTMLInputElement>(
      "#publish-form input[name='draftId']",
    );
    expect(field?.value).toBe(FRESH_DRAFT_ID);
  });

  it("disables Publish while the flush is in flight", async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", () => {
      calls.push("fetch:/api/drafts");
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            new Response(JSON.stringify({ draft: { id: FRESH_DRAFT_ID } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
      });
    });
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A title" },
    });
    fireEvent.click(publish);
    // The press used to leave the button untouched for the whole round-trip,
    // so a second press did nothing and looked like the first had too.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Publishing…" })).toBeTruthy(),
    );
    expect(
      screen
        .getByRole("button", { name: "Publishing…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    release?.();
    await waitFor(() => expect(calls).toContain("submit"));
  });
});

describe("/write — a post too long to store is refused without navigating", () => {
  let submitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    markdown.current = "body text";
    submitSpy = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    return () => {
      markdown.current = "body text";
      submitSpy.mockRestore();
      vi.unstubAllGlobals();
    };
  });

  it("keeps the writer on the page with every word still on screen", async () => {
    markdown.current = "x".repeat(MAX_BODY_LENGTH + 1);
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A very long post" },
    });
    fireEvent.click(publish);

    // The server refuses this too — but its refusal costs a full-page redirect
    // to the draft row, and the row's markdown column shares this exact cap.
    // So the flush cannot have succeeded, and the redirect would hand back the
    // last version that fit while looking like recovery.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("longer than one");
    expect(submitSpy).not.toHaveBeenCalled();
    // Still usable: this is a correctable mistake, not a dead end.
    expect(publish.hasAttribute("disabled")).toBe(false);
  });

  it("refuses a post inside the character cap but past the record's byte cap", async () => {
    // Half the character budget. The body is stored twice in the record —
    // formatted and as plain text — so it serializes to ~160 KB against a
    // 140 KB ceiling, and a data server answers 413. The character check above
    // waves this straight through; only measuring the record catches it.
    markdown.current = "x".repeat(80_000);
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A heavy post" },
    });
    fireEvent.click(publish);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert").textContent ?? "";
    // Names the real limit, and why bytes are not characters — otherwise a
    // writer counts their words, finds 40,000, and concludes we are lying.
    expect(alert).toContain("140,000 bytes");
    expect(alert).toMatch(/bytes aren't characters/i);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(publish.hasAttribute("disabled")).toBe(false);
  });

  it("refuses a non-Latin post at a quarter of the character cap", async () => {
    markdown.current = "字".repeat(25_000);
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "随筆" },
    });
    fireEvent.click(publish);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("140,000 bytes");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("publishes once the post is back under the limit", async () => {
    markdown.current = "x".repeat(MAX_BODY_LENGTH + 1);
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A very long post" },
    });
    fireEvent.click(publish);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    markdown.current = "trimmed";
    fireEvent.click(publish);
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
  });
});

describe("/write — resuming a draft keeps the images it already uploaded", () => {
  const STORED_BLOB = {
    $type: "blob",
    ref: { $link: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    mimeType: "image/png",
    size: 900,
  };

  it("submits the stored blob references when this session uploaded none", async () => {
    const submitSpy = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={{
          id: "12121212-3434-4565-8787-909090909090",
          title: "Illustrated",
          dek: "",
          blocksJson: "[]",
          markdown: "",
          inlineImages: JSON.stringify([STORED_BLOB]),
          schedule: null,
          imported: false,
        }}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const publish = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.click(publish);
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));

    // An empty field here is a record that references none of its own
    // pictures — which is a publish that succeeds and quietly breaks them,
    // because the PDS reclaims blobs nothing points at.
    const field = document.querySelector<HTMLInputElement>(
      "#publish-form input[name='images']",
    );
    expect(JSON.parse(field?.value ?? "[]")).toEqual([STORED_BLOB]);
    submitSpy.mockRestore();
  });
});

describe("/write — a dead draft pointer is not hidden by the publish error", () => {
  it("shows both notices when the resumed draft has gone missing", async () => {
    // A refused publish redirects with BOTH an error and a ?draft= — so when
    // that row has since been deleted, the writer is looking at an empty
    // editor for a reason that only the draft notice explains. Letting the
    // publish error alone win says "try again" over a page with nothing to
    // try again with.
    render(
      <Compose
        draft={null}
        draftError="draft_not_found"
        error="publish_failed:UpstreamFailure"
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    const alerts = screen.getAllByRole("alert").map((n) => n.textContent ?? "");
    expect(alerts.some((t) => t.includes("Publishing failed"))).toBe(true);
    expect(alerts.some((t) => t.includes("isn't in your drafts"))).toBe(true);
  });

  it("does not print the same notice twice", async () => {
    render(
      <Compose
        draft={null}
        draftError="not_found"
        error="not_found"
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "+" });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
