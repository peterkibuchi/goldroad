import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ReportLink in the footer reads useLocation, which wants a live router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: "/@writer.example" }),
}));

import { PublicationView } from "../routes/@{$handle}.index";
import {
  type RecommendationEntry,
  RecommendationsEditor,
} from "../routes/settings";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const LETTERS = {
  uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/site.standard.publication/3lyk73wxnok2f",
  name: "Friend's Letters",
  description: "Weekly notes from the hills.",
  href: "https://friend.leaflet.pub",
  host: "friend.leaflet.pub",
};
const SITE = {
  uri: "https://example.com/blog",
  name: "example.com/blog",
  description: null,
  href: "https://example.com/blog",
  host: "example.com/blog",
};

function page(recommendations: (typeof LETTERS | typeof SITE)[]) {
  return render(
    <PublicationView
      iconPath={null}
      ident="writer.example"
      nextCursor={null}
      posts={[]}
      publication={{ name: "The Long Way" }}
      recommendations={recommendations}
    />,
  );
}

describe("publication page — recommendations", () => {
  it("lists each by name and description, linking to its own site", () => {
    page([LETTERS, SITE]);
    const section = screen.getByRole("region", { name: "Recommended" });
    const links = within(section).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://friend.leaflet.pub",
      "https://example.com/blog",
    ]);
    expect(
      within(section).getByText("Weekly notes from the hills."),
    ).toBeTruthy();
    expect(within(section).getByText("friend.leaflet.pub")).toBeTruthy();
    // A website named by its address doesn't print the address twice.
    expect(within(section).getAllByText("example.com/blog")).toHaveLength(1);
  });

  it("renders no section when none resolved", () => {
    page([]);
    expect(screen.queryByRole("region", { name: "Recommended" })).toBeNull();
  });
});

describe("settings — the recommendations editor, by keyboard", () => {
  const ENTRIES: RecommendationEntry[] = [
    { uri: LETTERS.uri, card: LETTERS },
    { uri: SITE.uri, card: SITE },
    {
      uri: "at://did:plc:cccccccccccccccccccccccc/site.standard.publication/3lyk73wxnok2g",
      card: null,
    },
  ];

  function editor(entries = ENTRIES) {
    const view = render(<RecommendationsEditor entries={entries} />);
    const form = view.container.querySelector("form") as HTMLFormElement;
    return { form };
  }

  it("posts every kept entry back as stored, including one that didn't load", () => {
    const { form } = editor();
    expect(new FormData(form).getAll("recommendation")).toEqual(
      ENTRIES.map((e) => e.uri),
    );
    expect(new FormData(form).get("intent")).toBe("recommendations");
    expect(screen.getByText(/didn't load just now/i)).toBeTruthy();
    // One that didn't load still gets a Remove button that names it apart.
    expect(
      screen.getByRole("button", {
        name: "Remove Recommendation 3, which didn't load",
      }),
    ).toBeTruthy();
  });

  it("removes with a native button, then moves focus to the next entry's", async () => {
    const { form } = editor();
    const remove = screen.getByRole("button", {
      name: "Remove Friend's Letters",
    });
    expect(remove.tagName).toBe("BUTTON");
    expect(remove.getAttribute("type")).toBe("button");
    remove.focus();
    // Enter and Space on a native button are the browser's; they end in a click.
    await act(async () => fireEvent.click(remove));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove example.com/blog" }),
    );
    expect(new FormData(form).getAll("recommendation")).toEqual([
      SITE.uri,
      ENTRIES[2].uri,
    ]);
    expect(screen.getByRole("status").textContent).toMatch(
      /Removed Friend's Letters\. Save recommendations/,
    );
  });

  it("moves focus to the previous entry after removing the last, then to the add field", async () => {
    editor(ENTRIES.slice(0, 2));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Remove example.com/blog" }),
      ),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove Friend's Letters" }),
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Remove Friend's Letters" }),
      ),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Add a publication" }),
    );
    expect(screen.getByText("No recommendations yet.")).toBeTruthy();
  });

  it("turns the add field off at six, and says why", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      uri: `https://site${i}.example`,
      card: {
        ...SITE,
        uri: `https://site${i}.example`,
        name: `site${i}.example`,
      },
    }));
    editor(six);
    const add = screen.getByRole("textbox", { name: "Add a publication" });
    expect((add as HTMLInputElement).disabled).toBe(true);
    expect(add.getAttribute("aria-describedby")).toBe(
      "recommendation-add-help",
    );
    expect(screen.getByText(/that's six/i)).toBeTruthy();
  });
});
