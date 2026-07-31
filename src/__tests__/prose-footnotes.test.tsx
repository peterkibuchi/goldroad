import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Prose } from "#/components/prose";

afterEach(cleanup);

const SOURCE = `A contested claim.[^1] And a second one.[^note]

[^1]: Smith, *A History*, 2019, p. 44.
[^note]: See also [the original](https://example.com).
`;

/**
 * Footnotes are the one QoL gap that is a BLOCKER for a specific segment —
 * analytical non-fiction — and that segment is disproportionately the writers
 * with paying audiences and portability politics. They come free with GFM, so
 * what these pin is that they keep working and keep looking like footnotes.
 */
describe("footnotes on a reading page", () => {
  it("renders a marker for each reference and a note for each definition", () => {
    const { container } = render(<Prose markdown={SOURCE} />);
    const markers = container.querySelectorAll("sup a[data-footnote-ref]");
    expect(markers.length).toBe(2);
    expect(markers[0]?.textContent).toBe("1");
    expect(markers[1]?.textContent).toBe("2");
    expect(screen.getByText(/A History/)).toBeTruthy();
  });

  it("sets the notes apart from the body rather than running them on", () => {
    // The failure this replaces: the notes rendered as an ordinary numbered
    // list immediately after the last paragraph, with nothing marking the end
    // of the piece.
    const { container } = render(<Prose markdown={SOURCE} />);
    const notes = container.querySelector("section[data-footnotes]");
    expect(notes).toBeTruthy();
    expect(notes?.className).toContain("border-t");
    // The spec's own hook survives our styling — it is what any consumer of
    // this markup keys on.
    expect(notes?.className).toContain("footnotes");
  });

  it("keeps the notes heading available to screen readers only", () => {
    // GFM emits a visually-hidden "Footnotes" heading. The rule is a hidden
    // landmark, not a visible one: the horizontal rule is the sighted signal.
    const { container } = render(<Prose markdown={SOURCE} />);
    const heading = container.querySelector("#footnote-label");
    expect(heading).toBeTruthy();
    expect(heading?.className).toContain("sr-only");
  });

  it("links a marker to its note and back again", () => {
    const { container } = render(<Prose markdown={SOURCE} />);
    const ref = container.querySelector("a[data-footnote-ref]");
    const target = ref?.getAttribute("href")?.slice(1);
    expect(target).toBeTruthy();
    expect(
      container.querySelector(`#${CSS.escape(target ?? "")}`),
    ).toBeTruthy();
    expect(container.querySelector("a[data-footnote-backref]")).toBeTruthy();
  });

  it("leaves prose that merely contains a caret alone", () => {
    const { container } = render(
      <Prose markdown={"Cost is 2^10 dollars, or x[^y] where y is unset."} />,
    );
    expect(container.querySelector("section[data-footnotes]")).toBeNull();
  });
});
