// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Route } from "../routes/__root";

// The shell's own markup, without the router's head and script machinery.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  HeadContent: () => null,
  Scripts: () => null,
}));
vi.mock("@tanstack/react-devtools", () => ({ TanStackDevtools: () => null }));

type Meta = { name?: string; property?: string };
type RootOptions = {
  head: () => { meta: Meta[] };
  shellComponent: (props: { children: React.ReactNode }) => React.ReactNode;
};
const options = Route.options as unknown as RootOptions;

describe("root head", () => {
  it("never gives two meta tags one name or property", () => {
    // HeadContent keeps one tag per name or property (the last one in a
    // route, the deepest route's across them) and drops the rest. Tags that
    // need one name twice (theme-color, per colour scheme) render in the
    // shell instead.
    const keys = options
      .head()
      .meta.map((m) => m.name ?? m.property)
      .filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders a theme-color for each colour scheme", () => {
    const html = renderToStaticMarkup(
      <options.shellComponent>{null}</options.shellComponent>,
    );
    expect(html).toContain(
      '<meta content="#ffffff" media="(prefers-color-scheme: light)" name="theme-color"/>',
    );
    expect(html).toContain(
      '<meta content="#1a1815" media="(prefers-color-scheme: dark)" name="theme-color"/>',
    );
  });
});
