import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The editor draws the share card when the writer presses Publish or Save
 * changes, and the form waits for it. What these pin is the editor's half of
 * the contract with /api/publish: the card shows what the record will store,
 * an unchanged card on an edit travels as its CID rather than its bytes, and
 * a card that can't be drawn never holds the publish up.
 */
vi.mock("~/components/editor", async () => {
  const { useEffect } = await import("react");
  const fakeEditor = { document: [], blocksToMarkdownLossy: () => "words" };
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

const card = vi.hoisted(() => ({
  drawShareCard: vi.fn(),
  blobCid: vi.fn(),
}));
vi.mock("~/lib/share-card", () => card);

import { Compose } from "../routes/write";

const CID = "bafkreicardcardcardcardcardcardcardcard";
const facts = {
  label: "The Long Table",
  name: "@writer.example",
  theme: null,
};
const editing = {
  rkey: "3lyk7wxnok2fb",
  title: "Why I   stopped counting ",
  dek: "",
  markdown: "words",
  coverPath: null,
  shareCardCid: CID,
  mirror: null,
};

afterEach(cleanup);
let submitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  card.drawShareCard.mockReset();
  card.blobCid.mockReset();
  submitSpy = vi
    .spyOn(HTMLFormElement.prototype, "submit")
    .mockImplementation(() => {});
});
afterEach(() => submitSpy.mockRestore());

async function press(draft: typeof editing | null) {
  render(
    <Compose
      card={facts}
      draft={draft}
      error={undefined}
      reconnectHandle={null}
      resumed={null}
    />,
  );
  await screen.findByTestId("editor-region", {}, { timeout: 30_000 });
  const button = screen.getByRole("button", {
    name: draft ? "Save changes" : "Publish",
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  if (!draft)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A new post" },
    });
  fireEvent.click(button);
  await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
}

const field = (name: string) =>
  document.querySelector<HTMLInputElement>(
    `#publish-form input[name='${name}']`,
  );

describe("/write — the share card", () => {
  it("draws the card with the title as the record will store it", async () => {
    card.drawShareCard.mockResolvedValue(null);
    await press(editing);
    expect(card.drawShareCard).toHaveBeenCalledWith({
      ...facts,
      title: "Why I stopped counting",
    });
  }, 60_000);

  it("sends an unchanged card on an edit as its CID, not its bytes", async () => {
    card.drawShareCard.mockResolvedValue(new Blob(["png"]));
    card.blobCid.mockResolvedValue(CID);
    await press(editing);
    expect(field("shareCardKeep")?.value).toBe(CID);
    expect(field("shareCard")?.files).toHaveLength(0);
  });

  it("still publishes when no card could be drawn", async () => {
    card.drawShareCard.mockResolvedValue(null);
    await press(null);
    expect(field("shareCardKeep")?.value).toBe("");
    expect(field("shareCard")?.files).toHaveLength(0);
  });
});
