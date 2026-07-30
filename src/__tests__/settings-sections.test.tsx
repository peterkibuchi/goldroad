import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// settings.tsx is a route file: it reads Workers bindings at module scope —
// the `cloudflare:workers` alias in vitest.config.ts stubs them for this import.
import { IconField, SettingsSection } from "../routes/settings";

// No vitest globals in this repo — RTL auto-cleanup doesn't run; do it by hand.
afterEach(cleanup);

describe("SettingsSection — the page's structure is scannable", () => {
  it("is a landmark named by its own heading", () => {
    render(
      <SettingsSection
        id="publication"
        intro="What this band is for."
        title="Publication"
      >
        <p>fields</p>
      </SettingsSection>,
    );
    const region = screen.getByRole("region", { name: "Publication" });
    expect(region.textContent).toContain("What this band is for.");
    expect(screen.getByRole("heading", { name: "Publication" }).tagName).toBe(
      "H2",
    );
  });

  it("separates the destructive band with a full rule, not a hairline", () => {
    const { container: hairline } = render(
      <SettingsSection id="your-data" title="Your data">
        <p>export</p>
      </SettingsSection>,
    );
    expect(hairline.querySelector("section")?.className).toContain(
      "border-rule",
    );
    cleanup();

    const { container: heavy } = render(
      <SettingsSection
        id="delete-account"
        rule="heavy"
        title="Delete your account"
      >
        <p>danger</p>
      </SettingsSection>,
    );
    expect(heavy.querySelector("section")?.className).toContain("border-t-2");
  });
});

describe("IconField — the publication icon, finally writable", () => {
  it("offers an add affordance and no removal when there is no icon yet", () => {
    const { container } = render(
      <IconField existingPath={null} onBusyChange={() => {}} />,
    );
    // The file input is named "Icon" (both visible affordances point at it,
    // so the name comes from the field label, not from the labels).
    expect(screen.getByLabelText("Icon")).toBeTruthy();
    expect(screen.getByText("Add an icon")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove icon" })).toBeNull();
    expect(container.querySelector('input[name="removeIcon"]')).toBeNull();
    // SVG is never accepted (script-capable, and /img serves same-origin).
    const input =
      container.querySelector<HTMLInputElement>('input[name="icon"]');
    expect(input?.accept).not.toContain("svg");
    expect(input?.accept).toContain("image/png");
  });

  it("shows the icon in the record and lets it be replaced or removed", () => {
    const { container } = render(
      <IconField
        existingPath="/img/did%3Aplc%3Aaaa/bafkreiicon"
        onBusyChange={() => {}}
      />,
    );
    expect(screen.getByAltText("Icon preview").getAttribute("src")).toBe(
      "/img/did%3Aplc%3Aaaa/bafkreiicon",
    );
    expect(screen.getByText("Replace icon")).toBeTruthy();

    // Removal has to be explicit on the wire: an empty file input on its own
    // means "keep the icon that's there".
    fireEvent.click(screen.getByRole("button", { name: "Remove icon" }));
    expect(screen.queryByAltText("Icon preview")).toBeNull();
    expect(
      container
        .querySelector('input[name="removeIcon"]')
        ?.getAttribute("value"),
    ).toBe("1");
  });

  it("refuses a non-image pick in the browser, before any upload", () => {
    const onBusyChange = vi.fn();
    const { container } = render(
      <IconField existingPath={null} onBusyChange={onBusyChange} />,
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[name="icon"]',
    ) as HTMLInputElement;
    const file = new File(["not an image"], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);
    expect(screen.getByRole("alert").textContent).toContain("isn't an image");
    expect(onBusyChange).not.toHaveBeenCalled();
  });
});
