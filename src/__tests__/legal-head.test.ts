// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Route as policies } from "../routes/policies";
import { Route as privacy } from "../routes/privacy";
import { Route as terms } from "../routes/terms";

/** A shared /privacy link used to preview as a bare title: no canonical, no
 * og:* tags, nothing describing the card image it inherits. */
type HeadFn = () => {
  meta: Array<Record<string, string>>;
  links: Array<Record<string, string>>;
};
const headOf = (route: unknown) =>
  (route as { options: { head: HeadFn } }).options.head();

describe("policy pages — head tags for a link preview", () => {
  for (const [route, path] of [
    [privacy, "/privacy"],
    [terms, "/terms"],
    [policies, "/policies"],
  ] as const) {
    it(`gives ${path} a canonical URL, the og:* set and the card's description`, () => {
      const { meta, links } = headOf(route);
      const url = `https://trygoldroad.com${path}`;
      expect(links).toContainEqual({ rel: "canonical", href: url });
      expect(meta).toContainEqual({ property: "og:url", content: url });
      expect(meta).toContainEqual({ property: "og:type", content: "website" });
      const title = meta.find((m) => "title" in m)?.title;
      expect(meta).toContainEqual({ property: "og:title", content: title });
      const description = meta.find((m) => m.name === "description")?.content;
      expect(description).toBeTruthy();
      expect(meta).toContainEqual({
        property: "og:description",
        content: description,
      });
      expect(meta.some((m) => m.property === "og:image:alt")).toBe(true);
    });
  }
});
