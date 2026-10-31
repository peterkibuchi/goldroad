import {
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
import { PinnedPostField } from "../routes/settings";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

const post = (rkey: string, title: string) => ({
  rkey,
  title,
  description: null,
  publishedAt: "2026-01-05T00:00:00.000Z",
  coverPath: null,
  readingMinutes: 4,
});

const ABOUT = {
  ...post("3lyk73wxnok2f", "Who I am and what I write"),
  description: "Start with this one.",
};

function page(
  pinned: typeof ABOUT | null,
  posts = [post("3lzzzzzzzzzzz", "Newest"), ABOUT],
) {
  return render(
    <PublicationView
      iconPath={null}
      ident="writer.example"
      nextCursor={null}
      pinned={pinned}
      posts={posts}
      publication={{ name: "The Long Way" }}
    />,
  );
}

describe("publication page — Start here", () => {
  it("shows the pinned post first, under its own heading", () => {
    page(ABOUT);
    const section = screen.getByRole("region", { name: "Start here" });
    const link = within(section).getByRole("link");
    expect(link.getAttribute("href")).toBe("/@writer.example/3lyk73wxnok2f");
    expect(within(section).getByText("Start with this one.")).toBeTruthy();
    // First on the page: ahead of every archive row.
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf("Who I am and what I write")).toBeLessThan(
      headings.indexOf("Newest"),
    );
  });

  it("isn't listed a second time below", () => {
    page(ABOUT);
    expect(screen.getAllByText("Who I am and what I write")).toHaveLength(1);
  });

  it("renders the page as before when there is no pin", () => {
    page(null);
    expect(screen.queryByRole("region", { name: "Start here" })).toBeNull();
    expect(screen.getByText("Who I am and what I write")).toBeTruthy();
  });

  it("doesn't call a publication empty when its only post is pinned", () => {
    page(ABOUT, [ABOUT]);
    expect(screen.queryByText(/nothing published yet/i)).toBeNull();
    expect(screen.getByRole("region", { name: "Start here" })).toBeTruthy();
  });
});

describe("settings — the Start here pick", () => {
  const POSTS = [
    { rkey: "3lzzzzzzzzzzz", title: "Newest" },
    { rkey: "3lyk73wxnok2f", title: "Who I am" },
  ];

  it("is a native, labelled select, so the keyboard is the platform's", () => {
    render(<PinnedPostField pinnedRkey="3lyk73wxnok2f" posts={POSTS} />);
    const select = screen.getByRole("combobox", { name: "Start here" });
    expect(select.tagName).toBe("SELECT");
    expect(select.getAttribute("name")).toBe("pinnedPost");
    expect(select.getAttribute("tabindex")).toBeNull();
    expect(select.getAttribute("aria-describedby")).toBe("pinnedPost-help");
    expect((select as HTMLSelectElement).value).toBe("3lyk73wxnok2f");
  });

  it("submits the post chosen from the keyboard, or nothing for no pin", () => {
    render(
      <form data-testid="form">
        <PinnedPostField pinnedRkey={null} posts={POSTS} />
      </form>,
    );
    const select = screen.getByRole("combobox", { name: "Start here" });
    const form = screen.getByTestId("form") as HTMLFormElement;
    expect(new FormData(form).get("pinnedPost")).toBe("");
    select.focus();
    expect(document.activeElement).toBe(select);
    // jsdom doesn't run a select's arrow-key behaviour, which is the
    // browser's; the change it ends in is what the form carries.
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.change(select, { target: { value: "3lzzzzzzzzzzz" } });
    expect(new FormData(form).get("pinnedPost")).toBe("3lzzzzzzzzzzz");
  });

  it("leaves the field out when the posts couldn't be listed, so a save keeps the pin", () => {
    render(
      <form data-testid="form">
        <PinnedPostField pinnedRkey="3lyk73wxnok2f" posts={null} />
      </form>,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    const form = screen.getByTestId("form") as HTMLFormElement;
    expect(new FormData(form).has("pinnedPost")).toBe(false);
    expect(screen.getByText(/saving keeps your current pick/i)).toBeTruthy();
  });
});
