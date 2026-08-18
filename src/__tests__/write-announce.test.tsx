import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Consent, on the publish surface.
 *
 * Announcing is the default now, which changes what this control is for.
 * Nobody is being asked to opt in — they are being TOLD what pressing Publish
 * will do, early enough to change it. That is the whole difference between a
 * default and a surprise, and it is why the sentence lives beside the button
 * rather than in a confirmation afterwards.
 *
 * The second thing pinned here is less obvious and easier to break: ONE
 * decision has to reach TWO forms. The publish form is multipart and carries the
 * cover and the body; the schedule panel posts a due date through a form of its
 * own. A checkbox in each would let them disagree, and a writer would have no
 * way to tell which one they had answered.
 */
vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  const fakeEditor = {
    document: [{ type: "paragraph" }],
    blocksToMarkdownLossy: () => "Some words.",
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
      return <div data-testid="editor-region" />;
    },
  };
});

import { AnnounceToggle, Compose, SchedulePanel } from "../routes/write";

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";

afterEach(cleanup);

const ON = /followers see it as a card linking to your page/i;
const OFF = /won't see this post in their timelines/i;

describe("AnnounceToggle — the writer is told before they press", () => {
  const box = () => screen.getByRole("checkbox");

  it("starts from the account setting, whichever way it points", () => {
    render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    expect((box() as HTMLInputElement).checked).toBe(true);
    cleanup();
    render(
      <AnnounceToggle
        announce={false}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    expect((box() as HTMLInputElement).checked).toBe(false);
  });

  it("states the outcome for the ON state — the default, said out loud", () => {
    render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    screen.getByText(ON);
    expect(screen.queryByText(OFF)).toBeNull();
  });

  it("states the outcome for the OFF state too — absence is also a fact", () => {
    render(
      <AnnounceToggle
        announce={false}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    screen.getByText(OFF);
    expect(screen.queryByText(ON)).toBeNull();
  });

  it("points at where the default is changed", () => {
    // A writer who unticks this every time wants the setting changed, and
    // cannot be expected to guess that a setting exists.
    render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /change the default/i });
    expect(link.getAttribute("href")).toBe("/settings#announcing-heading");
  });

  it("joins the publish form by association, not by nesting", () => {
    // The publish form wraps only its fields — the editor has to live outside
    // it — so the control reaches the form the same way the Publish button does.
    render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    expect(box().getAttribute("form")).toBe("publish-form");
    expect(box().getAttribute("name")).toBe("announce");
    expect((box() as HTMLInputElement).value).toBe("1");
  });

  it("hands the change up rather than owning it", () => {
    const onChange = vi.fn();
    render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={onChange}
      />,
    );
    fireEvent.click(box());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("describes the box with the consequence line", () => {
    render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    expect(box().getAttribute("aria-describedby")).toBe("announce-consequence");
    expect(document.getElementById("announce-consequence")).not.toBeNull();
  });

  it("keeps the target big enough to hit", () => {
    const { container } = render(
      <AnnounceToggle
        announce={true}
        formId="publish-form"
        onChange={() => {}}
      />,
    );
    expect(container.querySelector("label")?.className).toContain("min-h-9");
  });
});

describe("the schedule panel carries the same decision", () => {
  let requestSubmit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => {});
    return () => requestSubmit.mockRestore();
  });

  async function submitSchedule(announce: boolean) {
    render(
      <SchedulePanel
        announce={announce}
        draftId={DRAFT_ID}
        existing={null}
        prepare={async () => DRAFT_ID}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Schedule for later/), {
      target: { value: "2027-08-04T09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Schedule/ }));
    await waitFor(() => expect(requestSubmit).toHaveBeenCalled());
    const form = (requestSubmit.mock.instances[0] ??
      requestSubmit.mock.contexts[0]) as HTMLFormElement;
    return new FormData(form);
  }

  it("submits the decision with the due date, so the row can capture it", async () => {
    const data = await submitSchedule(true);
    expect(data.get("intent")).toBe("schedule");
    expect(data.get("announce")).toBe("1");
  });

  it("submits an EXPLICIT no rather than nothing", async () => {
    // The handler reads a missing field as no as well, but a scheduled post is
    // the one that goes out unattended — it should not depend on that.
    const data = await submitSchedule(false);
    expect(data.get("announce")).toBe("0");
  });

  it("says in words what the scheduled post will do, both ways", () => {
    render(
      <SchedulePanel
        announce={true}
        draftId={DRAFT_ID}
        existing={null}
        prepare={async () => DRAFT_ID}
      />,
    );
    screen.getByText(/announces on Bluesky when it goes out/i);
    cleanup();
    render(
      <SchedulePanel
        announce={false}
        draftId={DRAFT_ID}
        existing={null}
        prepare={async () => DRAFT_ID}
      />,
    );
    screen.getByText(/won't be announced on Bluesky/i);
  });

  it("does not grow a second checkbox of its own", () => {
    // Two controls for one decision is a decision a writer cannot answer.
    render(
      <SchedulePanel
        announce={true}
        draftId={DRAFT_ID}
        existing={null}
        prepare={async () => DRAFT_ID}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("the editor wires one decision to both forms", () => {
  const publishedDraft = {
    rkey: "3lyk73wxnok2f",
    title: "Live post",
    dek: "",
    markdown: "words",
    coverPath: null,
    mirror: null,
  };

  it("offers the toggle on a new post, pre-filled from the account setting", async () => {
    render(
      <Compose
        announceDefault={true}
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    const box = await screen.findByRole("checkbox", {
      name: /announce this post on bluesky/i,
    });
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("moves the schedule panel with it, from one click", async () => {
    render(
      <Compose
        announceDefault={true}
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    const box = await screen.findByRole("checkbox", {
      name: /announce this post on bluesky/i,
    });
    // The panel agrees before the click...
    screen.getByText(/announces on Bluesky when it goes out/i);
    fireEvent.click(box);
    // ...and after it. One decision, two forms.
    screen.getByText(/won't be announced on Bluesky/i);
    screen.getByText(/won't see this post in their timelines/i);
  });

  it("starts unticked for a writer who turned announcing off", async () => {
    render(
      <Compose
        announceDefault={false}
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    const box = await screen.findByRole("checkbox", {
      name: /announce this post on bluesky/i,
    });
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("offers NOTHING when editing a published post", async () => {
    // An edit changes a record that is already public and never announces, so a
    // toggle here would promise something the server will not do.
    render(
      <Compose
        announceDefault={true}
        draft={publishedDraft}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: /Save changes/ });
    expect(
      screen.queryByRole("checkbox", {
        name: /announce this post on bluesky/i,
      }),
    ).toBeNull();
    expect(screen.queryByText(ON)).toBeNull();
  });
});
