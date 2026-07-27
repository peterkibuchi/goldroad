/**
 * Reader-surface markdown rendering: correctness for markdown AND plain
 * prose (superset), and the safety property — raw HTML in third-party
 * records must stay inert (no elements, no script execution).
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Prose } from "../components/prose";

describe("Prose", () => {
  it("renders markdown structure", () => {
    const { container } = render(
      <Prose
        markdown={
          "# Section\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two"
        }
      />,
    );
    // Headings are shifted down one level — the document title owns h1.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Section");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("rel")).toContain("nofollow");
  });

  it("renders GFM extensions (strikethrough, tables)", () => {
    const { container } = render(
      <Prose markdown={"~~gone~~\n\n| a | b |\n| - | - |\n| 1 | 2 |"} />,
    );
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("renders plain multi-paragraph prose as paragraphs (third-party plaintext records)", () => {
    const { container } = render(
      <Prose markdown={"First paragraph.\n\nSecond paragraph."} />,
    );
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("First paragraph.");
  });

  it("keeps raw HTML inert — never becomes elements", () => {
    const { container } = render(
      <Prose
        markdown={
          '<script>window.pwned = true;</script>\n\n<img src="x" onerror="window.pwned = true;">\n\nsafe text'
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(container.textContent).toContain("safe text");
  });

  it("strips javascript: URLs via react-markdown's default urlTransform", () => {
    const { container } = render(
      <Prose markdown={"[click](javascript:alert(1))"} />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
