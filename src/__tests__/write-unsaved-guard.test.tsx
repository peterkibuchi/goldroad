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

// Regression guard for the unguarded-edit bug: editing a published post
// deliberately does NOT autosave (shadow-copying edits into the drafts table
// would fork the record, which is the writer's own source of truth). That made
// the leave-page confirmation the only thing standing between a stray click and
// lost work — and it was bundled into the same `if (editing) return` as the
// autosave, so the surface with no safety net got no guard either. Every link
// in the command rail is a full-page navigation, so there was nothing to catch.
vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  const fakeEditor = { document: [], blocksToMarkdownLossy: () => "body text" };
  return {
    default: function FakeEditor({
      onReady,
    }: {
      onReady: (editor: unknown) => void;
    }) {
      useEffect(() => {
        onReady(fakeEditor);
      }, [onReady]);
      return <div data-testid="editor-region" />;
    },
  };
});

import { Compose } from "../routes/write";

afterEach(cleanup);

const publishedPost = {
  rkey: "3lyk73wxnok2f",
  title: "Live post",
  dek: "",
  markdown: "words",
  coverPath: null,
  mirror: null,
};

/** Fires a real cancelable beforeunload and reports whether anything asked the
 * browser to confirm. `defaultPrevented` is exactly what the browser reads. */
function leavePagePrompted(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// See write-editor-submit.test.tsx: the first mount of this route pays a
// one-time lazy-chunk and role-engine cost that would otherwise land inside the
// first test's wait window. Spend it here, off the clock.
beforeAll(async () => {
  render(
    <Compose
      draft={null}
      error={undefined}
      reconnectHandle={null}
      resumed={null}
    />,
  );
  await screen.findByLabelText("Title", undefined, { timeout: 30_000 });
  cleanup();
}, 60_000);

describe("/write — the leave-page guard covers edits of published posts", () => {
  let submitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    submitSpy = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    return () => submitSpy.mockRestore();
  });

  async function renderEdit() {
    render(
      <Compose
        draft={publishedPost}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "Save changes" });
    return screen.getByLabelText("Title");
  }

  it("warns before leaving an edited published post", async () => {
    const title = await renderEdit();
    fireEvent.change(title, { target: { value: "Live post, revised" } });
    expect(leavePagePrompted()).toBe(true);
  });

  it("stays silent when the writer only opened the post", async () => {
    await renderEdit();
    // Loading a post into the editor fires onChange before the writer touches
    // anything; treating that as an edit would prompt on every plain read.
    expect(leavePagePrompted()).toBe(false);
  });

  it("stays silent once the edit has been submitted", async () => {
    const title = await renderEdit();
    fireEvent.change(title, { target: { value: "Live post, revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    // Saving supersedes the guard — the navigation it triggers is the writer's.
    expect(leavePagePrompted()).toBe(false);
  });

  it("still warns on an unsaved new composition", async () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "Publish" });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A title" },
    });
    expect(leavePagePrompted()).toBe(true);
  });

  it("does not warn on an untouched new composition", async () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "Publish" });
    expect(leavePagePrompted()).toBe(false);
  });
});
