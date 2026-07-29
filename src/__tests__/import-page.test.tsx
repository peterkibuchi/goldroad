import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The /import source step: two clearly labeled doors (paste a feed, upload
 * an export file) and the honest per-host error copy. The Substack branch
 * matters most — Substack answers 429 to every fetch from our server, so
 * "try again" copy would be a lie; the error must point at the upload path
 * that actually works. import.tsx is a route file: the `cloudflare:workers`
 * alias in vitest.config.ts stubs its bindings.
 */
import { isSubstackHost, SourcePicker } from "../routes/import";

afterEach(cleanup);

function renderPicker(
  props: Partial<React.ComponentProps<typeof SourcePicker>> = {},
) {
  const onFeed = vi.fn();
  const onFile = vi.fn();
  render(
    <SourcePicker
      busy={null}
      error={null}
      onFeed={onFeed}
      onFile={onFile}
      {...props}
    />,
  );
  return { onFeed, onFile };
}

describe("SourcePicker — the two doors", () => {
  it("offers both paths, clearly labeled", () => {
    renderPicker();
    expect(
      screen.getByLabelText(/paste your publication's address/i),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { name: /upload your export/i }),
    ).toBeDefined();
    // The file is parsed locally; the page says so.
    expect(screen.getByText(/never uploaded/i)).toBeDefined();
  });

  it("names all four supported export platforms honestly", () => {
    renderPicker();
    const text = screen.getByText(/upload the export file/i).textContent ?? "";
    for (const platform of ["Substack", "Medium", "Ghost", "WordPress"]) {
      expect(text).toContain(platform);
    }
  });

  it("accepts a zip, json, or xml export file", () => {
    renderPicker();
    const input = screen.getByLabelText<HTMLInputElement>(
      /choose your export file/i,
    );
    const accept = input.getAttribute("accept") ?? "";
    expect(accept).toContain(".zip");
    expect(accept).toContain(".json");
    expect(accept).toContain(".xml");
  });

  it("takes an export file via the file input and passes the confirmed host along", () => {
    const { onFile } = renderPicker();
    const input = screen.getByLabelText<HTMLInputElement>(
      /choose your export file/i,
    );
    fireEvent.change(screen.getByLabelText(/address \(optional/i), {
      target: { value: "you.substack.com" },
    });
    const file = new File(["PK"], "export.zip", { type: "application/zip" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file, "you.substack.com");
  });

  it("submits the feed path with the pasted address", () => {
    const { onFeed } = renderPicker();
    fireEvent.change(screen.getByLabelText(/paste your publication's/i), {
      target: { value: " https://ghost.example/feed " },
    });
    fireEvent.submit(
      screen
        .getByRole("button", { name: /find my posts/i })
        .closest("form") as HTMLFormElement,
    );
    expect(onFeed).toHaveBeenCalledWith("https://ghost.example/feed");
  });

  it("announces parse progress as text, not spinners", () => {
    renderPicker({ busy: "reading" });
    expect(screen.getByRole("status").textContent).toContain(
      "stays on your machine",
    );
  });
});

describe("SourcePicker — honest per-host errors", () => {
  it("substack.com hosts get the truth and the upload path, not retry copy", () => {
    renderPicker({
      error: { code: "fetch_failed", url: "https://you.substack.com" },
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "Substack blocks automated fetching from our server",
    );
    expect(alert.textContent).toContain("your full archive");
    const link = screen.getByRole("link", {
      name: /upload your substack export/i,
    });
    expect(link.getAttribute("href")).toBe("#substack-export");
  });

  it("a 429 (upstream_blocked) gets the upload path even on a custom domain", () => {
    renderPicker({
      error: { code: "upstream_blocked", url: "https://my-own-domain.com" },
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("blocking automated fetching");
    expect(alert.textContent).toContain("custom domains included");
    expect(
      screen
        .getByRole("link", { name: /upload your substack export/i })
        .getAttribute("href"),
    ).toBe("#substack-export");
  });

  it("generic hosts keep the plain fetch-failed copy", () => {
    renderPicker({
      error: { code: "fetch_failed", url: "https://ghost.example" },
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("couldn't be reached right now");
    expect(alert.textContent).not.toContain("Substack");
  });

  it("zip errors speak in file terms", () => {
    renderPicker({ error: { code: "not_an_export" } });
    expect(screen.getByRole("alert").textContent).toContain("posts/ folder");
  });
});

describe("isSubstackHost", () => {
  it("matches substack.com and subdomains, with or without a scheme", () => {
    expect(isSubstackHost("https://you.substack.com/feed")).toBe(true);
    expect(isSubstackHost("you.substack.com")).toBe(true);
    expect(isSubstackHost("substack.com")).toBe(true);
  });

  it("never matches look-alikes or other hosts", () => {
    expect(isSubstackHost("https://notsubstack.com")).toBe(false);
    expect(isSubstackHost("https://substack.com.evil.example")).toBe(false);
    expect(isSubstackHost("https://ghost.example")).toBe(false);
    expect(isSubstackHost("")).toBe(false);
  });
});
