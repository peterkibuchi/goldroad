import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduling from the editor.
 *
 * The load-bearing behaviour here is the ORDER: a schedule saves the draft
 * first and only then submits the due date, because the cron publishes what is
 * STORED, hours later, with nobody watching. A save that fails must therefore
 * schedule nothing at all — a post going out with older words in it than the
 * writer approved is exactly the kind of quiet wrongness this feature must not
 * introduce.
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

import { Compose, SchedulePanel } from "../routes/write";

const DRAFT_ID = "11111111-2222-4333-8444-555555555555";
const ROW_ID = "99999999-8888-4777-8666-555555555555";

afterEach(cleanup);

describe("SchedulePanel — its own form, and what it refuses to do", () => {
  let requestSubmit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => {});
    return () => requestSubmit.mockRestore();
  });

  function panel(
    prepare: () => Promise<string | null>,
    existing: { id: string; dueAt: string } | null = null,
  ) {
    render(
      <SchedulePanel
        draftId={DRAFT_ID}
        existing={existing}
        prepare={prepare}
      />,
    );
    return {
      time: screen.getByLabelText(/Schedule for later|Change the time/),
      button: screen.getByRole("button", { name: /Schedule|Reschedule/ }),
    };
  }

  it("saves the draft BEFORE submitting the schedule", async () => {
    const order: string[] = [];
    const prepare = vi.fn(async () => {
      order.push("save");
      return DRAFT_ID;
    });
    requestSubmit.mockImplementation(() => {
      order.push("submit");
    });
    const { time, button } = panel(prepare);
    fireEvent.change(time, { target: { value: "2027-08-04T09:00" } });
    fireEvent.click(button);
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["save", "submit"]);
  });

  it("carries the draft id and the offset for the CHOSEN moment", async () => {
    const { time, button } = panel(async () => DRAFT_ID);
    fireEvent.change(time, { target: { value: "2027-08-04T09:00" } });
    fireEvent.click(button);
    await waitFor(() => expect(requestSubmit).toHaveBeenCalled());

    const form = (requestSubmit.mock.instances[0] ??
      requestSubmit.mock.contexts[0]) as HTMLFormElement;
    const data = new FormData(form);
    expect(data.get("intent")).toBe("schedule");
    expect(data.get("draftId")).toBe(DRAFT_ID);
    expect(data.get("dueAtLocal")).toBe("2027-08-04T09:00");
    // Whatever zone this test runs in, the offset sent must be the one that
    // zone had at the chosen moment — the property that makes a DST-straddling
    // schedule land on the right hour.
    const expected = new Date(2027, 7, 4, 9, 0).getTimezoneOffset();
    expect(Number(data.get("dueTzOffset"))).toBe(expected);
  });

  it("schedules NOTHING when the draft save fails, and says why", async () => {
    const { time, button } = panel(async () => null);
    fireEvent.change(time, { target: { value: "2027-08-04T09:00" } });
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't be saved/i);
  });

  it("recovers when the save THROWS, instead of locking the button", async () => {
    // Exporting the markdown is the editor's work and can throw as well as
    // fail; a stuck disabled button with no message is the worst of both.
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { time, button } = panel(async () => {
      throw new Error("markdown export failed");
    });
    fireEvent.change(time, { target: { value: "2027-08-04T09:00" } });
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(requestSubmit).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    quiet.mockRestore();
  });

  it("asks for a time instead of submitting an empty one", async () => {
    const prepare = vi.fn(async () => DRAFT_ID);
    const { button } = panel(prepare);
    fireEvent.click(button);
    await screen.findByRole("alert");
    // Not even a save: there is nothing to schedule yet.
    expect(prepare).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("shows an existing schedule with its zone named, and offers a cancel", () => {
    render(
      <SchedulePanel
        draftId={DRAFT_ID}
        existing={{ id: ROW_ID, dueAt: "2027-08-04T06:00:00.000Z" }}
        prepare={async () => DRAFT_ID}
      />,
    );
    // The label always names a zone, in either render — a bare "9:00" is the
    // one thing a writer can misread.
    const time = screen.getByText(/Aug 4, 2027/);
    expect(time.textContent).toMatch(/UTC|GMT|[A-Z]{2,5}|[+-]\d/);
    expect(
      screen.getByRole("button", { name: "Cancel the schedule" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeTruthy();
  });

  it("cancels by the schedule's id, but returns to the DRAFT", () => {
    // The two ids are both UUIDs, so sending the wrong one here would land the
    // writer in a blank editor with a "draft not found" and their piece
    // apparently gone.
    render(
      <SchedulePanel
        draftId={DRAFT_ID}
        existing={{ id: ROW_ID, dueAt: "2027-08-04T06:00:00.000Z" }}
        prepare={async () => DRAFT_ID}
      />,
    );
    const cancel = screen
      .getByRole("button", { name: "Cancel the schedule" })
      .closest("form") as HTMLFormElement;
    const data = new FormData(cancel);
    expect(data.get("intent")).toBe("unschedule");
    expect(data.get("id")).toBe(ROW_ID);
    expect(data.get("draftId")).toBe(DRAFT_ID);
    expect(data.get("returnTo")).toBe("write");
  });

  it("states the cover limitation where the decision is made", () => {
    render(
      <SchedulePanel
        draftId={null}
        existing={null}
        prepare={async () => DRAFT_ID}
      />,
    );
    expect(document.body.textContent).toMatch(/not a cover image/i);
  });
});

describe("Compose — the schedule control's place in the publish flow", () => {
  it("offers scheduling on a new composition", async () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    expect(
      await screen.findByRole(
        "button",
        { name: "Schedule" },
        { timeout: 30_000 },
      ),
    ).toBeTruthy();
  }, 60_000);

  it("does NOT offer it while editing a post that is already public", async () => {
    render(
      <Compose
        draft={{
          rkey: "3lyk73wxnok2f",
          title: "Live post",
          dek: "",
          textContent: "words",
          coverPath: null,
          mirror: null,
        }}
        error={undefined}
        reconnectHandle={null}
        resumed={null}
      />,
    );
    await screen.findByRole("button", { name: "Save changes" });
    expect(screen.queryByRole("button", { name: "Schedule" })).toBeNull();
  });

  it("shows the pending schedule when a queued draft is reopened", async () => {
    render(
      <Compose
        draft={null}
        error={undefined}
        reconnectHandle={null}
        resumed={{
          id: DRAFT_ID,
          title: "Queued",
          dek: "",
          blocksJson: "[]",
          inlineImages: "",
          imported: false,
          schedule: { id: ROW_ID, dueAt: "2027-08-04T06:00:00.000Z" },
        }}
      />,
    );
    expect(await screen.findByText(/Aug 4, 2027/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel the schedule" }),
    ).toBeTruthy();
  });
});
