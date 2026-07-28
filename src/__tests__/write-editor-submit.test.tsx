import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the add-block-publishes bug: BlockNote's internal UI
// buttons (side-menu +, drag handle, slash-menu items) don't set
// type="button", and a type-less button inside a form is a SUBMIT button.
// The editor therefore must never be a descendant of the publish <form>.
// The mock stands in for BlockNote with exactly that hazard: a type-less
// button rendered where the editor mounts.
vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  // One STABLE instance, like the real useCreateBlockNote: onReady fires per
  // effect run, and Compose's setEditor must bail out on an identical value
  // (a fresh object each run would loop the update cycle forever).
  const fakeEditor = {
    document: [],
    blocksToMarkdownLossy: () => "body text",
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

// write.tsx is a route file: it reads Workers bindings at module scope — the
// `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { Compose } from "../routes/write";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

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
