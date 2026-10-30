// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Route } from "../routes/__root";

type Meta = { name?: string; property?: string };

describe("root head", () => {
  it("never gives two meta tags one name or property", () => {
    // HeadContent keeps the first tag per name or property and drops the
    // rest, so a second one here never reaches the page. Tags that need the
    // same name twice (theme-color, per colour scheme) render in the shell.
    const head = (Route.options as unknown as { head: () => { meta: Meta[] } })
      .head;
    const keys = head()
      .meta.map((m) => m.name ?? m.property)
      .filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
